import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDbTestApp, userClient } from '../support/db-app.js';

/**
 * The Cost page's API against real ledger rows. Rows are dated in April 2101 and queried with
 * an explicit range, so whatever other tests leave in the database cannot change the numbers.
 */
const url = process.env.TEST_DATABASE_URL;
const DAY = '2101-04-10T10:00:00Z';
const RANGE = '?from=2101-04-10&to=2101-04-10';

describe.skipIf(!url)('admin metrics and feedback (Postgres)', () => {
  const db = new pg.Pool({ connectionString: url, max: 2 });
  let app: INestApplication;
  let base: string;
  const tenant = randomUUID();
  const asAdmin = () => userClient(base, tenant, { 'cognito:groups': ['admin'] });
  const asMember = () => userClient(base, randomUUID());

  const request = (status: string, cost: number, cache = 'miss') =>
    db.query(
      `INSERT INTO rag_requests (id, tenant_id, config, config_hash, prompt_version, model, status,
                                 cache_type, cost_usd, created_at)
       VALUES ($1, $2, '{}', 'h', 'v1', 'gpt-6-luna', $3, $4, $5, $6) RETURNING id`,
      [randomUUID(), tenant, status, cache, cost, DAY],
    );

  beforeAll(async () => {
    ({ app, base } = await startDbTestApp('admin.test'));
    await asAdmin()('GET', '/api/me');
    for (const [purpose, input, cached, output] of [
      ['chat', 3000, 1264, 20],
      ['chat', 3000, 0, 20],
      ['query_embed', 10, 0, 0],
    ] as const) {
      await db.query(
        `INSERT INTO llm_calls (tenant_id, purpose, model, input_tokens, cached_tokens,
                                output_tokens, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenant,
          purpose,
          purpose === 'chat' ? 'gpt-6-luna' : 'text-embedding-3-small',
          input,
          cached,
          output,
          DAY,
        ],
      );
    }
    await request('answered', 0.0003);
    await request('answered', 0.0005);
    const { rows } = await request('cached', 0, 'exact');
    await request('no_answer_gate', 0.0000002);
    await db.query(
      `INSERT INTO cost_savings (request_id, mechanism, basis, baseline_usd, actual_usd, saved_usd, created_at)
       VALUES ($1, 'exact_cache', 'estimated', 0.0003, 0, 0.0003, $2)`,
      [rows[0].id, DAY],
    );
    // A thumbs-down on an answer, with the question it answered.
    const conversation = (
      await db.query('INSERT INTO conversations (tenant_id) VALUES ($1) RETURNING id', [tenant])
    ).rows[0].id as string;
    const requestId = randomUUID();
    const answer = (
      await db.query(
        `INSERT INTO messages (conversation_id, tenant_id, role, content, status, rag_request_id)
       VALUES ($1, $2, 'user', 'How long is maternity leave?', 'complete', $3),
              ($1, $2, 'assistant', '34 weeks [1].', 'complete', $3) RETURNING id`,
        [conversation, tenant, requestId],
      )
    ).rows[1].id as string;
    await db.query(
      `INSERT INTO feedback (message_id, tenant_id, request_id, rating, reasons, comment)
       VALUES ($1, $2, $3, -1, '{wrong_citation}', 'Page 98 says more')`,
      [answer, tenant, requestId],
    );
  });

  afterAll(async () => {
    await db.query("DELETE FROM cost_savings WHERE created_at >= '2100-01-01'");
    await db.query("DELETE FROM users WHERE email LIKE '%@admin.test'");
    await db.query("DELETE FROM app_daily_usage WHERE day >= '2100-01-01'");
    await app.close();
    await db.end();
  });

  it('is for admins only', async () => {
    for (const path of [`/api/admin/metrics${RANGE}`, '/api/admin/feedback']) {
      const res = await asMember()('GET', path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('reports spend per day and purpose, cache hit rates and booked savings from the ledger', async () => {
    const res = await asAdmin()('GET', `/api/admin/metrics${RANGE}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      spendByDay: unknown[];
      requests: Record<string, unknown>;
      promptCache: { cachedShare: number };
      savings: unknown[];
    };
    expect(body.spendByDay).toEqual([
      // 1,736 ordinary + 1,264 cached + 20 out, and 3,000 + 20 out, at gpt-6-luna prices
      { day: '2101-04-10', purpose: 'chat', costUsd: expect.closeTo(0.00050624, 10), calls: 2 },
      {
        day: '2101-04-10',
        purpose: 'query_embed',
        costUsd: expect.closeTo(0.0000002, 10),
        calls: 1,
      },
    ]);
    expect(body.requests).toMatchObject({
      total: 4,
      answered: 2,
      refused: 1,
      exactCacheHits: 1,
      exactCacheHitRate: 0.25,
      answeredP50Usd: expect.closeTo(0.0004, 10),
    });
    expect(body.promptCache).toMatchObject({ inputTokens: 6000, cachedTokens: 1264 });
    expect(body.promptCache.cachedShare).toBeCloseTo(1264 / 6000, 6);
    expect(body.savings).toEqual([
      { mechanism: 'exact_cache', basis: 'estimated', count: 1, savedUsd: 0.0003 },
    ]);
  });

  it('lists thumbs-downs with the question, the answer and the reasons', async () => {
    const res = await asAdmin()('GET', '/api/admin/feedback');

    const body = (await res.json()) as { down: number; items: Record<string, unknown>[] };
    expect(body.down).toBeGreaterThanOrEqual(1);
    expect(body.items).toContainEqual(
      expect.objectContaining({
        question: 'How long is maternity leave?',
        answer: '34 weeks [1].',
        reasons: ['wrong_citation'],
        comment: 'Page 98 says more',
      }),
    );
  });

  it('rejects an inverted date range', async () => {
    const res = await asAdmin()('GET', '/api/admin/metrics?from=2101-05-01&to=2101-04-01');

    expect(res.status).toBe(400);
  });
});
