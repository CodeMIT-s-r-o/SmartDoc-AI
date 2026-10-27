// Stand-in for the NestJS API: streams its own SSE, or relays the Python function's stream
// through a SigV4-signed request to its Function URL (as the API will call the AI service).
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { createServer } from 'node:http';

const STARTED = Date.now();
const AI_URL = new URL(process.env.AI_URL);
let served = 0;

const signer = new SignatureV4({
  service: 'lambda',
  region: process.env.AWS_REGION,
  sha256: Sha256,
  credentials: async () => ({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  }),
});

const sse = (res) =>
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const seconds = Number(url.searchParams.get('seconds') ?? 90);
  const cold = served++ === 0;
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  const body = req.method === 'POST' ? await readBody(req) : '';
  const hello = {
    from: 'node',
    cold,
    upS: (Date.now() - STARTED) / 1000,
    method: req.method,
    body,
  };

  if (url.pathname.endsWith('/direct')) {
    sse(res);
    res.write(event('hello', hello));
    for (let i = 0; i < seconds; i++) {
      res.write(event('tick', { i, sent: Date.now() / 1000 }));
      await sleep(1000);
    }
    res.end(event('done', { from: 'node' }));
    return;
  }
  if (url.pathname.endsWith('/chain')) {
    const target = new URL(`/stream?seconds=${seconds}`, AI_URL);
    const signed = await signer.sign({
      method: 'GET',
      protocol: 'https:',
      hostname: target.hostname,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers: { host: target.hostname },
    });
    const upstream = await fetch(target, { headers: signed.headers });
    if (!upstream.ok || !upstream.body) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ upstream: upstream.status, body: await upstream.text() }));
      return;
    }
    sse(res);
    res.write(event('hello', hello));
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
    return;
  }
  res.writeHead(404).end();
}).listen(8080);
