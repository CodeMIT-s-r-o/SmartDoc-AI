// node infra/spike/check.mjs <cdn-url> <node-function-url> [seconds]
// Streams through CloudFront and reports, per stream: time to first byte, events received, the
// largest gap between two events (buffering shows up as one big gap), and whether `done` arrived.
import { createHash } from 'node:crypto';

const [cdn, functionUrl, secondsArg = '90'] = process.argv.slice(2);
const seconds = Number(secondsArg);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function stream(name, path, init = {}) {
  const started = performance.now();
  const res = await fetch(`${cdn}${path}`, init);
  const ttfb = performance.now() - started;
  if (!res.ok || !res.body) {
    return { name, status: res.status, error: (await res.text()).slice(0, 200) };
  }
  const arrivals = [];
  let hello;
  let done = false;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const type = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
      if (type === 'tick') arrivals.push(performance.now());
      if (type === 'hello')
        hello = { ...hello, [data.from]: { cold: data.cold, upS: data.upS ?? data.up_s } };
      if (type === 'done') done = true;
    }
  }
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  return {
    name,
    status: res.status,
    ttfbMs: Math.round(ttfb),
    ticks: arrivals.length,
    maxGapMs: Math.round(Math.max(0, ...gaps)),
    totalS: Math.round((performance.now() - started) / 100) / 10,
    done,
    hello,
    pass: done && arrivals.length === seconds && Math.max(0, ...gaps) < 2500,
  };
}

const body = JSON.stringify({ content: 'How long is maternity leave?' });
const results = await Promise.all([
  stream('direct (node only)', `/api/spike/direct?seconds=${seconds}`),
  stream('chain (node → python)', `/api/spike/chain?seconds=${seconds}`),
  stream('chain, POST with payload hash', `/api/spike/chain?seconds=${seconds}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-amz-content-sha256': sha256(body) },
    body,
  }),
]);
const unsigned = await fetch(`${functionUrl}api/spike/direct?seconds=1`);
const noHash = await fetch(`${cdn}/api/spike/direct?seconds=1`, { method: 'POST', body });

console.table(results.map((r) => ({ ...r, hello: undefined })));
console.log('cold starts:', JSON.stringify(results.map((r) => r.hello)));
console.log(`Function URL without CloudFront: ${unsigned.status} (want 403)`);
console.log(`POST through CloudFront without x-amz-content-sha256: ${noHash.status}`);
process.exitCode = results.every((r) => r.pass) && unsigned.status === 403 ? 0 : 1;
