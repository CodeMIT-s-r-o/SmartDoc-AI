import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDbTestApp, userClient } from '../support/db-app.js';
import { key, mountedRoutes, type Route } from '../support/routes.js';

/**
 * Tenant isolation, generated from the routes the app actually mounts: user B calls every `:id`
 * route with user A's ids and must get 404 (never 403, never a hint that the id exists) and change
 * nothing. A new `:id` route fails this file until it gets a fixture below, so a forgotten
 * ownership check cannot ship silently.
 */
const url = process.env.TEST_DATABASE_URL;

type Owned = 'document' | 'conversation' | 'answer';

/** `METHOD path` -> which of A's resources goes into `:id`, and a body that passes validation. */
const ID_ROUTES: Record<string, { resource: Owned; body?: () => unknown }> = {
  'GET /api/documents/:id': { resource: 'document' },
  'DELETE /api/documents/:id': { resource: 'document' },
  'POST /api/documents/:id/complete': { resource: 'document' },
  'GET /api/documents/:id/file': { resource: 'document' },
  'GET /api/conversations/:id': { resource: 'conversation' },
  'PATCH /api/conversations/:id': { resource: 'conversation', body: () => ({ title: 'Taken' }) },
  'DELETE /api/conversations/:id': { resource: 'conversation' },
  'POST /api/conversations/:id/messages': {
    resource: 'conversation',
    body: () => ({ clientMessageId: randomUUID(), content: 'What is in here?' }),
  },
  'POST /api/messages/:id/feedback': {
    resource: 'answer',
    body: () => ({ rating: -1, reasons: ['other'], comment: 'not mine' }),
  },
  'DELETE /api/messages/:id/feedback': { resource: 'answer' },
};

/** Service-to-service routes: a user's access token alone must never open them. */
const INTERNAL_ROUTES = ['POST /internal/documents/:id/download-url'];

describe.skipIf(!url)('tenant isolation over every mounted route', () => {
  const db = new pg.Pool({ connectionString: url, max: 2 });
  let app: INestApplication;
  let base: string;
  let routes: Route[];
  const owner = randomUUID();
  const intruder = randomUUID();
  const ids = {} as Record<Owned, string>;
  const asOwner = (...args: Parameters<ReturnType<typeof userClient>>) =>
    userClient(base, owner)(...args);
  const asIntruder = (...args: Parameters<ReturnType<typeof userClient>>) =>
    userClient(base, intruder)(...args);

  const ownerState = async () =>
    (
      await db.query<{ document: string; title: string; messages: number; rating: number }>(
        `SELECT (SELECT status FROM documents WHERE id = $1) AS document,
                (SELECT title FROM conversations WHERE id = $2) AS title,
                (SELECT count(*)::int FROM messages WHERE conversation_id = $2) AS messages,
                (SELECT rating FROM feedback WHERE message_id = $3) AS rating`,
        [ids.document, ids.conversation, ids.answer],
      )
    ).rows[0];

  beforeAll(async () => {
    ({ app, base } = await startDbTestApp('idor.test'));
    routes = mountedRoutes(app);
    // The first authenticated request creates each users row.
    await asOwner('GET', '/api/me');
    await asIntruder('GET', '/api/me');

    ids.document = randomUUID();
    await db.query(
      `INSERT INTO documents (id, tenant_id, title, original_filename, s3_key, size_bytes, status)
       VALUES ($1, $2, 'Owner handbook', 'h.pdf', 'k', 1, 'ready')`,
      [ids.document, owner],
    );
    const conversation = await asOwner('POST', '/api/conversations', { title: 'Owner chat' });
    ids.conversation = ((await conversation.json()) as { id: string }).id;
    const requestId = randomUUID();
    const [, answer] = (
      await db.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, tenant_id, role, content, status, rag_request_id,
                               client_message_id)
         VALUES ($1, $2, 'user', 'How much leave?', 'complete', $3, $4),
                ($1, $2, 'assistant', '25 days [1].', 'complete', $3, NULL)
         RETURNING id`,
        [ids.conversation, owner, requestId, randomUUID()],
      )
    ).rows;
    ids.answer = answer!.id;
  });

  afterAll(async () => {
    await db.query("DELETE FROM users WHERE email LIKE '%@idor.test'");
    await app.close();
    await db.end();
  });

  it('has a fixture for every :id route, and none for routes that are gone', () => {
    const mounted = routes.filter((r) => r.path.includes(':')).map(key);
    const covered = [...Object.keys(ID_ROUTES), ...INTERNAL_ROUTES];

    // A failure here lists the route that needs an entry in ID_ROUTES (or INTERNAL_ROUTES).
    expect(mounted.filter((r) => !covered.includes(r))).toEqual([]);
    expect(covered.filter((r) => !mounted.includes(r))).toEqual([]);
  });

  it('lets the owner reach every fixture id, so a 404 below means isolation', async () => {
    const reads = await Promise.all([
      asOwner('GET', `/api/documents/${ids.document}`),
      asOwner('GET', `/api/conversations/${ids.conversation}`),
      asOwner('POST', `/api/messages/${ids.answer}/feedback`, { rating: 1 }),
    ]);

    expect(reads.map((r) => r.status)).toEqual([200, 200, 204]);
    expect(await ownerState()).toEqual({
      document: 'ready',
      title: 'Owner chat',
      messages: 2,
      rating: 1,
    });
  });

  it("answers 404 to another user on every :id route and changes none of the owner's data", async () => {
    const results: { route: string; status: number; code: unknown }[] = [];
    for (const [route, fixture] of Object.entries(ID_ROUTES)) {
      const [method, path] = route.split(' ') as [string, string];
      const res = await asIntruder(
        method,
        path.replace(':id', ids[fixture.resource]),
        fixture.body?.(),
      );
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      results.push({ route, status: res.status, code: body.code });
    }

    expect(results).toEqual(
      Object.keys(ID_ROUTES).map((route) => ({ route, status: 404, code: 'NOT_FOUND' })),
    );
    expect(await ownerState()).toEqual({
      document: 'ready',
      title: 'Owner chat',
      messages: 2,
      rating: 1,
    });
  });

  it('refuses internal routes to a user token', async () => {
    for (const route of INTERNAL_ROUTES) {
      const [method, path] = route.split(' ') as [string, string];
      const res = await asOwner(method, path.replace(':id', ids.document));
      expect({ route, status: res.status }).toEqual({ route, status: 401 });
    }
  });

  it("never shows the owner's data in another user's lists", async () => {
    const lists = routes.filter((r) => r.method === 'GET' && !r.path.includes(':'));
    expect(lists.map(key)).toEqual(
      expect.arrayContaining(['GET /api/documents', 'GET /api/conversations', 'GET /api/me']),
    );

    for (const route of lists) {
      const text = await (await asIntruder('GET', route.path)).text();
      for (const secret of [owner, ...Object.values(ids), 'Owner handbook', 'Owner chat']) {
        expect({ route: key(route), leaks: text.includes(secret) }).toEqual({
          route: key(route),
          leaks: false,
        });
      }
    }
  });
});
