import { describe, expect, it } from 'vitest';
import { parseSseEvent, TERMINAL_EVENTS } from './sse.js';

const uuid = '00000000-0000-4000-8000-000000000001';

describe('parseSseEvent', () => {
  it('parses a token event', () => {
    expect(parseSseEvent('token', '{"d":"Hello"}')).toEqual({
      event: 'token',
      data: { d: 'Hello' },
    });
  });

  it('parses a cached done event with null retrieval latency', () => {
    const done = {
      status: 'cached',
      citedSources: [1],
      citationsValid: true,
      usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, embedding: 0 },
      costUsd: 0,
      savedUsd: 0.00041,
      latencyMs: { retrieval: null, ttft: null, total: 12 },
      abstained: false,
      traceId: null,
    };
    const parsed = parseSseEvent('done', JSON.stringify(done));
    expect(parsed.event).toBe('done');
    expect(TERMINAL_EVENTS.has(parsed.event)).toBe(true);
  });

  it('rejects an unknown event name', () => {
    expect(() => parseSseEvent('progress', '{}')).toThrow();
  });

  it('rejects an error event with an unknown code', () => {
    expect(() =>
      parseSseEvent('error', JSON.stringify({ code: 'NOPE', message: 'x', retryable: false })),
    ).toThrow();
  });

  it('rejects an ack event with a malformed id', () => {
    const ack = {
      requestId: 'r1',
      conversationId: uuid,
      userMessageId: uuid,
      assistantMessageId: uuid,
    };
    expect(() => parseSseEvent('ack', JSON.stringify(ack))).toThrow();
  });
});
