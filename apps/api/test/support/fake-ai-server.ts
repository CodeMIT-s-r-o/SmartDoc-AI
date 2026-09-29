import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const FAKE_AI_PORT = 18765;
const INTERNAL_TOKEN = 'test-internal-token-0123456789';

export interface RecordedRequest {
  body: {
    requestId: string;
    tenantId: string;
    conversationId: string;
    question: string;
    history: { role: string; content: string }[];
    documentIds: string[];
  };
  closedEarly: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Stands in for the Python AI service. The question picks the scenario:
 * "slow" streams for ~3 s, "fail" ends with an error event, "cut" drops the connection without a
 * terminal event, "reject" answers HTTP 500; anything else answers normally.
 */
export class FakeAiServer {
  readonly requests: RecordedRequest[] = [];
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(FAKE_AI_PORT, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
      res.writeHead(401).end();
      return;
    }
    let raw = '';
    for await (const part of req) {
      raw += String(part);
    }
    const record: RecordedRequest = {
      body: JSON.parse(raw) as RecordedRequest['body'],
      closedEarly: false,
    };
    this.requests.push(record);
    res.on('close', () => {
      if (!res.writableEnded) {
        record.closedEarly = true;
      }
    });

    const q = record.body.question;
    if (q.includes('reject')) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      frame('meta', {
        requestId: record.body.requestId,
        model: 'gpt-6-luna',
        promptVersion: 'v1',
        cache: 'miss',
      }),
    );
    res.write(
      frame('sources', [
        {
          n: 1,
          chunkId: '00000000-0000-4000-8000-00000000c001',
          documentId: record.body.documentIds[0],
          title: 'Handbook',
          section: '4 Leave',
          pageStart: 12,
          pageEnd: 12,
          score: 0.71,
          snippet: 'Employees get 25 days.',
        },
      ]),
    );
    if (q.includes('fail')) {
      res.write(frame('token', { d: 'You get' }));
      res.end(
        frame('error', {
          code: 'OPENAI_ERROR',
          message: 'The answer was interrupted.',
          retryable: true,
        }),
      );
      return;
    }
    if (q.includes('cut')) {
      res.write(frame('token', { d: 'You get' }));
      res.destroy();
      return;
    }
    const tokens = q.includes('slow')
      ? Array.from({ length: 10 }, (_, i) => `word${i} `)
      : ['You get ', '25 days ', '[1].'];
    for (const d of tokens) {
      if (res.destroyed) {
        return;
      }
      res.write(frame('token', { d }));
      if (q.includes('slow')) {
        await sleep(300);
      }
    }
    res.end(
      frame('done', {
        status: 'answered',
        citedSources: [1],
        citationsValid: true,
        usage: { input: 1700, cached: 1264, cacheWrite: 0, output: 9, reasoning: 0, embedding: 9 },
        costUsd: 0.000056,
        savedUsd: 0,
        latencyMs: { retrieval: 200, ttft: 900, total: 1000 },
        abstained: false,
        traceId: null,
      }),
    );
  }
}
