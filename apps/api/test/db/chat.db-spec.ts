import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatHousekeeping } from '../../src/chat/chat-housekeeping.js';
import { startDbTestApp, userClient } from '../support/db-app.js';
import { FakeAiServer } from '../support/fake-ai-server.js';

const url = process.env.TEST_DATABASE_URL;

interface SseEvent {
  event: string;
  data: Record<string, unknown> & { d?: string };
}

const parseSse = (text: string): SseEvent[] =>
  text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return {
        event: eventLine!.slice(7),
        data: JSON.parse(dataLine!.slice(6)) as SseEvent['data'],
      };
    });

describe.skipIf(!url)('chat: conversations and SSE streaming (Postgres + fake AI service)', () => {
  const ai = new FakeAiServer();
  const db = new pg.Pool({ connectionString: url, max: 2 });
  let app: INestApplication;
  let base: string;

  /** A signed-in tenant with one ready document. */
  const tenant = async () => {
    const sub = randomUUID();
    const documentId = randomUUID();
    const asUser = userClient(base, sub);
    const call = (method: string, path: string, body?: unknown, signal?: AbortSignal) =>
      asUser(method, `/api${path}`, body, signal);
    // First request creates the users row, then the document can reference it.
    await call('GET', '/me');
    await db.query(
      `INSERT INTO documents (id, tenant_id, title, original_filename, s3_key, size_bytes, status)
       VALUES ($1, $2, 'Handbook', 'h.pdf', 'k', 1, 'ready')`,
      [documentId, sub],
    );
    const conversation = (await (await call('POST', '/conversations', {})).json()) as {
      id: string;
    };
    const send = (content: string, clientMessageId: string = randomUUID(), signal?: AbortSignal) =>
      call(
        'POST',
        `/conversations/${conversation.id}/messages`,
        { clientMessageId, content },
        signal,
      );
    return { sub, documentId, conversationId: conversation.id, call, send };
  };

  const messages = async (conversationId: string) =>
    (
      await db.query<{
        role: string;
        status: string;
        content: string;
        citations: unknown;
        client_message_id: string | null;
      }>(
        `SELECT role, status, content, citations, client_message_id FROM messages
          WHERE conversation_id = $1 ORDER BY created_at, role DESC`,
        [conversationId],
      )
    ).rows;

  beforeAll(async () => {
    await ai.start();
    ({ app, base } = await startDbTestApp('chat-e2e.test'));
  });

  afterAll(async () => {
    await db.query("DELETE FROM users WHERE email LIKE '%@chat-e2e.test'");
    await app.close();
    await ai.stop();
    await db.end();
  });

  it('streams ack, meta, sources, tokens and done, and persists both messages', async () => {
    const t = await tenant();

    const res = await t.send('How many days of annual leave do I get?');

    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      'ack',
      'meta',
      'sources',
      'token',
      'token',
      'token',
      'done',
    ]);
    const ack = events[0]!.data;
    expect(ack.conversationId).toBe(t.conversationId);

    const [user, assistant] = await messages(t.conversationId);
    expect(user).toMatchObject({
      role: 'user',
      status: 'complete',
      content: 'How many days of annual leave do I get?',
    });
    expect(assistant).toMatchObject({
      role: 'assistant',
      status: 'complete',
      content: 'You get 25 days [1].',
    });
    expect(assistant!.citations).toEqual([
      expect.objectContaining({ n: 1, pageStart: 12, cited: true }),
    ]);

    const [request] = ai.requests.filter((r) => r.body.conversationId === t.conversationId);
    expect(request!.body).toMatchObject({
      tenantId: t.sub,
      documentIds: [t.documentId],
      history: [],
    });
    expect(request!.body.requestId).toBe(ack.requestId);

    const detail = (await (await t.call('GET', `/conversations/${t.conversationId}`)).json()) as {
      conversation: { title: string };
      messages: { role: string }[];
    };
    expect(detail.conversation.title).toBe('How many days of annual leave do I get?');
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('sends the previous turn as history', async () => {
    const t = await tenant();
    await (await t.send('First question')).text();

    await (await t.send('Follow-up question')).text();

    const [, second] = ai.requests.filter((r) => r.body.conversationId === t.conversationId);
    expect(second!.body.history).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'You get 25 days [1].' },
    ]);
  });

  it('answers a repeated clientMessageId from the database, without a second LLM call', async () => {
    const t = await tenant();
    const clientMessageId = randomUUID();
    await (await t.send('Question once', clientMessageId)).text();
    const callsBefore = ai.requests.length;

    const res = await t.send('Question once', clientMessageId);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = (await res.json()) as { assistantMessage: { content: string; status: string } };
    expect(body.assistantMessage).toMatchObject({
      content: 'You get 25 days [1].',
      status: 'complete',
    });
    expect(ai.requests.length).toBe(callsBefore);
    expect(await messages(t.conversationId)).toHaveLength(2);
  });

  it('refuses the same clientMessageId while its answer is still streaming', async () => {
    const t = await tenant();
    const clientMessageId = randomUUID();
    const first = await t.send('slow question', clientMessageId);
    const reader = first.body!.getReader();
    await reader.read(); // the ack has arrived: the turn exists

    const again = await t.send('slow question', clientMessageId);

    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('IN_PROGRESS');
    while (!(await reader.read()).done) {
      // drain
    }
  });

  it('marks the answer aborted and cancels the upstream call when the client hangs up', async () => {
    const t = await tenant();
    const controller = new AbortController();
    const res = await t.send('slow question to abandon', randomUUID(), controller.signal);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: token')) {
      seen += decoder.decode((await reader.read()).value);
    }

    controller.abort();

    await vi.waitFor(async () => {
      const [, assistant] = await messages(t.conversationId);
      expect(assistant?.status).toBe('aborted');
      expect(assistant?.content).toMatch(/^word0/);
    });
    const upstream = ai.requests.find((r) => r.body.conversationId === t.conversationId)!;
    await vi.waitFor(() => expect(upstream.closedEarly).toBe(true));
  });

  it.each([
    ['an error event from the AI service', 'please fail', 'OPENAI_ERROR'],
    ['a stream that stops without a terminal event', 'please cut', 'UPSTREAM_TIMEOUT'],
    ['an AI service that answers 500', 'please reject', 'UPSTREAM_TIMEOUT'],
  ])('ends %s with one error event and an error message', async (_, question, code) => {
    const t = await tenant();

    const events = parseSse(await (await t.send(question)).text());

    const terminal = events.filter((e) => e.event === 'done' || e.event === 'error');
    expect(terminal).toEqual([{ event: 'error', data: expect.objectContaining({ code }) }]);
    const [, assistant] = await messages(t.conversationId);
    expect(assistant?.status).toBe('error');
  });

  it('asks the user to upload first when no document is ready (before any stream)', async () => {
    const t = await tenant();
    await db.query("UPDATE documents SET status = 'processing' WHERE id = $1", [t.documentId]);

    const res = await t.send('Anything?');

    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toMatch(/problem\+json/);
    expect(((await res.json()) as { code: string }).code).toBe('NO_DOCUMENTS');
    expect(await messages(t.conversationId)).toHaveLength(0);
  });

  it('keeps conversations and documents tenant-private', async () => {
    const owner = await tenant();
    const other = await tenant();

    const foreignConversation = await other.call(
      'POST',
      `/conversations/${owner.conversationId}/messages`,
      {
        clientMessageId: randomUUID(),
        content: 'hi',
      },
    );
    const foreignDocument = await other.call(
      'POST',
      `/conversations/${other.conversationId}/messages`,
      {
        clientMessageId: randomUUID(),
        content: 'hi',
        documentIds: [owner.documentId],
      },
    );

    expect(foreignConversation.status).toBe(404);
    expect(foreignDocument.status).toBe(404);
    expect((await other.call('GET', `/conversations/${owner.conversationId}`)).status).toBe(404);
    expect((await other.call('DELETE', `/conversations/${owner.conversationId}`)).status).toBe(404);
  });

  it('lists, renames and deletes conversations (messages cascade)', async () => {
    const t = await tenant();
    await (await t.send('Hello')).text();

    const list = (await (await t.call('GET', '/conversations')).json()) as { id: string }[];
    expect(list.map((c) => c.id)).toContain(t.conversationId);
    const renamed = await t.call('PATCH', `/conversations/${t.conversationId}`, {
      title: 'Leave questions',
    });
    expect(((await renamed.json()) as { title: string }).title).toBe('Leave questions');

    expect((await t.call('DELETE', `/conversations/${t.conversationId}`)).status).toBe(204);
    expect(await messages(t.conversationId)).toHaveLength(0);
  });

  it('shows the ledger cost and latency on the answer, and stores thumbs', async () => {
    const t = await tenant();
    const events = parseSse(await (await t.send('How many days of annual leave do I get?')).text());
    const { requestId, assistantMessageId, userMessageId } = events[0]!.data as Record<
      string,
      string
    >;
    // The AI service writes this row; the fake one does not.
    await db.query(
      `INSERT INTO rag_requests (id, tenant_id, conversation_id, config, config_hash,
         prompt_version, model, status, cost_usd, ttft_ms, total_ms)
       VALUES ($1, $2, $3, '{}', 'h', 'v1', 'm', 'answered', 0.000381, 1200, 1500)`,
      [requestId, t.sub, t.conversationId],
    );
    const detail = async () =>
      (
        (await (await t.call('GET', `/conversations/${t.conversationId}`)).json()) as {
          messages: { costUsd: number | null; latencyMs: unknown; rating: number | null }[];
        }
      ).messages;
    const rate = (id: string, body: unknown) => t.call('POST', `/messages/${id}/feedback`, body);

    expect(await detail()).toEqual([
      expect.objectContaining({ costUsd: null, latencyMs: null, rating: null }),
      expect.objectContaining({ costUsd: 0.000381, latencyMs: { ttft: 1200, total: 1500 } }),
    ]);

    const down = await rate(assistantMessageId!, {
      rating: -1,
      reasons: ['wrong_citation'],
      comment: 'Page 3 says 20 days',
    });
    expect(down.status).toBe(204);
    const [row] = (
      await db.query(
        'SELECT request_id, rating, reasons, comment FROM feedback WHERE message_id = $1',
        [assistantMessageId],
      )
    ).rows;
    expect(row).toEqual({
      request_id: requestId,
      rating: -1,
      reasons: ['wrong_citation'],
      comment: 'Page 3 says 20 days',
    });

    expect((await rate(assistantMessageId!, { rating: 1 })).status).toBe(204);
    expect((await detail())[1]?.rating).toBe(1);
    expect(
      (await db.query('SELECT reasons FROM feedback WHERE message_id = $1', [assistantMessageId]))
        .rows,
    ).toEqual([{ reasons: null }]);

    expect((await t.call('DELETE', `/messages/${assistantMessageId}/feedback`)).status).toBe(204);
    expect((await detail())[1]?.rating).toBeNull();

    // Only answers can be rated, reasons only with a thumbs-down, and never someone else's.
    expect((await rate(userMessageId!, { rating: 1 })).status).toBe(404);
    expect((await rate(assistantMessageId!, { rating: 1, reasons: ['other'] })).status).toBe(400);
    const other = await tenant();
    expect(
      (await other.call('POST', `/messages/${assistantMessageId}/feedback`, { rating: -1 })).status,
    ).toBe(404);
    expect((await other.call('DELETE', `/messages/${assistantMessageId}/feedback`)).status).toBe(
      404,
    );
  });

  it('closes streaming messages left behind by a crashed process', async () => {
    const t = await tenant();
    await db.query(
      `INSERT INTO messages (conversation_id, tenant_id, role, status, created_at)
       VALUES ($1, $2, 'assistant', 'streaming', now() - interval '3 minutes')`,
      [t.conversationId, t.sub],
    );

    const closed = await app.get(ChatHousekeeping).tick();

    expect(closed).toBeGreaterThanOrEqual(1);
    expect((await messages(t.conversationId))[0]?.status).toBe('error');
  });
});
