import { describe, expect, it } from 'vitest';
import { StreamCollector } from './stream-collector.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const done = {
  status: 'answered',
  citedSources: [1],
  citationsValid: true,
  usage: { input: 1, cached: 0, cacheWrite: 0, output: 1, reasoning: 0, embedding: 1 },
  costUsd: 0,
  savedUsd: 0,
  latencyMs: { retrieval: 1, ttft: 1, total: 2 },
  abstained: false,
  traceId: null,
};

describe('StreamCollector', () => {
  it('reassembles frames and multi-byte characters split across chunks', () => {
    const collector = new StreamCollector();
    const stream = bytes(
      frame('token', { d: 'Dovolenka je 25 dní ' }) + frame('token', { d: '[1].' }),
    );
    // Split inside the "í" (two bytes in UTF-8) and inside the second frame.
    const cut = stream.indexOf(0xad);
    collector.feed(stream.slice(0, cut));
    collector.feed(stream.slice(cut, cut + 20));
    collector.feed(stream.slice(cut + 20));

    expect(collector.text).toBe('Dovolenka je 25 dní [1].');
    expect(collector.terminal).toBe(false);
  });

  it('counts events that break the contract instead of storing them', () => {
    const collector = new StreamCollector();

    collector.feed(
      bytes(frame('token', { text: 'wrong field' }) + 'event: token\ndata: {not json\n\n'),
    );
    collector.feed(bytes(frame('surprise', {})));

    expect(collector.text).toBe('');
    expect(collector.invalidEvents).toBe(3);
  });

  it('becomes terminal on done or error', () => {
    const answered = new StreamCollector();
    answered.feed(bytes(frame('done', done)));
    const failed = new StreamCollector();
    failed.feed(bytes(frame('error', { code: 'OPENAI_ERROR', message: 'x', retryable: true })));

    expect(answered.terminal).toBe(true);
    expect(answered.done?.citedSources).toEqual([1]);
    expect(failed.terminal).toBe(true);
    expect(failed.error?.code).toBe('OPENAI_ERROR');
  });
});
