import { describe, expect, it } from 'vitest';
import type { MessageDto } from './api';
import { applyEvent, chatItems, fromLive, type LiveTurn } from './view';

const ids = {
  requestId: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-000000000002',
  userMessageId: '00000000-0000-4000-8000-000000000003',
  assistantMessageId: '00000000-0000-4000-8000-000000000004',
};

const source = {
  n: 1,
  chunkId: '00000000-0000-4000-8000-000000000005',
  documentId: '00000000-0000-4000-8000-000000000006',
  title: 'Handbook',
  section: 'Leave',
  pageStart: 12,
  pageEnd: 12,
  score: 0.8,
  snippet: '25 days',
};

const turn = (overrides: Partial<LiveTurn> = {}): LiveTurn => ({
  clientMessageId: 'c1',
  question: 'How much leave?',
  text: '',
  sources: [],
  stopped: false,
  running: true,
  ...overrides,
});

const message = (overrides: Partial<MessageDto>): MessageDto => ({
  id: ids.assistantMessageId,
  role: 'assistant',
  content: 'You get 25 days [1].',
  status: 'complete',
  citations: null,
  costUsd: 0.0003,
  latencyMs: { ttft: 900, total: 1400 },
  rating: null,
  createdAt: '2026-09-29T10:00:00Z',
  ...overrides,
});

describe('live answers', () => {
  it('moves through searching, reading and writing, then maps done to a stored status', () => {
    let live = applyEvent(turn(), { event: 'ack', data: ids });
    expect(fromLive(live).phase).toBe('searching');
    live = applyEvent(live, { event: 'sources', data: [source] });
    expect(fromLive(live).phase).toBe('reading');
    live = applyEvent(live, { event: 'token', data: { d: 'You get 25 days [1].' } });
    expect(fromLive(live)).toMatchObject({ phase: 'writing', status: 'streaming' });

    live = applyEvent(live, {
      event: 'done',
      data: {
        status: 'no_answer_model',
        citedSources: [1],
        citationsValid: true,
        usage: { input: 1, cached: 0, cacheWrite: 0, output: 1, reasoning: 0, embedding: 1 },
        costUsd: 0.0002,
        savedUsd: 0,
        latencyMs: { retrieval: 10, ttft: 20, total: 30 },
        abstained: true,
        traceId: null,
      },
    });
    expect(fromLive({ ...live, running: false })).toMatchObject({
      status: 'no_answer',
      phase: null,
      messageId: ids.assistantMessageId,
      costUsd: 0.0002,
      citations: [{ n: 1, cited: true }],
    });
  });

  it('tells a stopped answer from a connection that dropped without a terminal event', () => {
    expect(fromLive(turn({ running: false, stopped: true, text: 'Par' })).status).toBe('aborted');
    expect(fromLive(turn({ running: false, text: 'Par' }))).toMatchObject({
      status: 'error',
      error: expect.stringContaining('connection dropped'),
    });
    expect(fromLive(turn({ running: false, error: 'The answer was interrupted.' })).error).toBe(
      'The answer was interrupted.',
    );
  });
});

describe('chatItems', () => {
  const question = message({ id: ids.userMessageId, role: 'user', content: 'How much leave?' });
  const live = turn({ ack: ids, text: 'You get', running: true });

  it('shows the live turn instead of its stored rows while the answer is still streaming', () => {
    const items = chatItems([question, message({ status: 'streaming', content: '' })], live);

    expect(items.map((i) => i.key)).toEqual(['live-q-c1', 'live-a-c1']);
    expect(items[1]).toMatchObject({ kind: 'answer', answer: { text: 'You get' } });
  });

  it('switches to the stored answer once it is final', () => {
    const items = chatItems([question, message({})], { ...live, running: false });

    expect(items.map((i) => i.key)).toEqual([ids.userMessageId, ids.assistantMessageId]);
    expect(items[1]).toMatchObject({ question: 'How much leave?', answer: { costUsd: 0.0003 } });
  });

  it('keeps a failed send (never acknowledged) at the end of the conversation', () => {
    const failed = turn({ running: false, error: 'Too many questions in a short time.' });
    const items = chatItems([question, message({})], failed);

    expect(items.map((i) => i.key)).toEqual([
      ids.userMessageId,
      ids.assistantMessageId,
      'live-q-c1',
      'live-a-c1',
    ]);
  });
});
