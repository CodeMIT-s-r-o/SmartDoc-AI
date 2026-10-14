import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BudgetExceeded,
  BudgetService,
  ESTIMATE_INPUT_TOKENS,
  ESTIMATE_OUTPUT_TOKENS,
} from '../../src/budget/budget.service.js';
import type { Env } from '../../src/config/env.js';
import * as schema from '../../src/db/schema.js';
import { startDbTestApp, userClient } from '../support/db-app.js';
import { FakeAiServer } from '../support/fake-ai-server.js';

const url = process.env.TEST_DATABASE_URL;

/** gpt-6-luna list price: (4,600 × $0.10 + 600 × $0.50) / 1M. */
const EST = (ESTIMATE_INPUT_TOKENS * 0.1 + ESTIMATE_OUTPUT_TOKENS * 0.5) / 1e6;

describe.skipIf(!url)('daily budgets with reservations (Postgres)', () => {
  const db = new pg.Pool({ connectionString: url, max: 2 });
  // Its own pool, wide enough that 10 reservations really run at the same time.
  const servicePool = new pg.Pool({ connectionString: url, max: 12 });
  const orm = drizzle({ client: servicePool, schema, casing: 'snake_case' });
  let now = new Date();

  /** A BudgetService on a frozen clock; days far in the future keep app_daily_usage isolated. */
  const budgets = (globalCapUsd = 1000) =>
    new BudgetService(
      orm,
      {
        get: (key: keyof Env) =>
          ({ GLOBAL_DAILY_CAP_USD: globalCapUsd, RAG_CHAT_MODEL: 'gpt-6-luna' })[key as string],
      } as unknown as ConfigService<Env, true>,
      () => now,
    );

  const user = async (dailyLimitUsd: number) => {
    const id = randomUUID();
    await db.query('INSERT INTO users (id, email, daily_limit_usd) VALUES ($1, $2, $3)', [
      id,
      `${id}@budget.test`,
      dailyLimitUsd,
    ]);
    return id;
  };

  const usage = async (tenantId: string) =>
    (
      await db.query<{ day: string; reserved: string; spent: string }>(
        `SELECT day::text, reserved_usd::float8 AS reserved, spent_usd::float8 AS spent
           FROM user_daily_usage WHERE tenant_id = $1 ORDER BY day`,
        [tenantId],
      )
    ).rows;

  const appReserved = async (day: string) =>
    (
      await db.query<{ reserved: number }>(
        'SELECT reserved_usd::float8 AS reserved FROM app_daily_usage WHERE day = $1',
        [day],
      )
    ).rows[0]?.reserved;

  afterAll(async () => {
    await db.query("DELETE FROM users WHERE email LIKE '%@budget.test'");
    await db.query("DELETE FROM app_daily_usage WHERE day >= '2100-01-01'");
    await servicePool.end();
    await db.end();
  });

  it('lets the first request of the day through and creates both usage rows', async () => {
    now = new Date('2101-05-10T08:00:00Z');
    const tenant = await user(0.25);
    const requestId = randomUUID();

    await budgets().reserve(tenant, requestId);

    expect(await usage(tenant)).toEqual([{ day: '2101-05-10', reserved: EST, spent: 0 }]);
    expect(await appReserved('2101-05-10')).toBeCloseTo(EST, 12);
    const [reservation] = (
      await db.query(
        'SELECT day::text, est_usd::float8 AS est, expires_at FROM budget_reservations WHERE request_id = $1',
        [requestId],
      )
    ).rows as { day: string; est: number; expires_at: Date }[];
    expect(reservation).toEqual({
      day: '2101-05-10',
      est: EST,
      expires_at: new Date('2101-05-10T08:05:00Z'),
    });
  });

  it('never reserves past the limit, however many requests race for it', async () => {
    now = new Date('2101-05-11T08:00:00Z');
    const tenant = await user(Number((3.5 * EST).toFixed(4))); // room for 3, not 4
    const service = budgets();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.reserve(tenant, randomUUID())),
    );

    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof BudgetExceeded,
    ).length;
    expect({ accepted, refused }).toEqual({ accepted: 3, refused: 7 });
    expect((await usage(tenant))[0]?.reserved).toBeCloseTo(3 * EST, 12);
  });

  it('releases to the day it charged, even after midnight, and only once', async () => {
    // 22:59:59 UTC on 15 March 2101 is 23:59:59 in Bratislava (CET, before the DST switch).
    now = new Date('2101-03-15T22:59:59Z');
    const tenant = await user(0.25);
    const service = budgets();
    const requestId = randomUUID();
    await service.reserve(tenant, requestId);

    now = new Date('2101-03-15T23:00:30Z'); // 00:00:30 on 16 March in Bratislava
    expect(await service.release(requestId)).toBe(true);
    expect(await service.release(requestId)).toBe(false);
    await service.reserve(tenant, randomUUID());

    expect(await usage(tenant)).toEqual([
      { day: '2101-03-15', reserved: 0, spent: 0 },
      { day: '2101-03-16', reserved: EST, spent: 0 },
    ]);
    expect(await appReserved('2101-03-15')).toBe(0);
  });

  it('says when the budget resets: the next midnight in Bratislava', async () => {
    now = new Date('2101-07-20T20:30:00Z'); // 22:30 CEST
    const tenant = await user(EST / 2);

    const error = await budgets()
      .reserve(tenant, randomUUID())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetExceeded);
    expect(error).toMatchObject({
      scope: 'user',
      resetsAt: new Date('2101-07-20T22:00:00Z'),
      retryAfterS: 90 * 60,
    });
    expect(await usage(tenant)).toEqual([]); // the refused transaction left nothing behind
  });

  it('stops everyone at the global cap, without charging the refused user', async () => {
    now = new Date('2101-05-12T08:00:00Z');
    const service = budgets(2.5 * EST);
    const [first, second, third] = [await user(0.25), await user(0.25), await user(0.25)];

    await service.reserve(first, randomUUID());
    await service.reserve(second, randomUUID());
    const error = await service.reserve(third, randomUUID()).catch((e: unknown) => e);

    expect(error).toMatchObject({ scope: 'app' });
    expect(await usage(third)).toEqual([]);
    expect(await appReserved('2101-05-12')).toBeCloseTo(2 * EST, 12);
  });

  it('frees reservations that a crashed request never released', async () => {
    now = new Date('2101-05-13T08:00:00Z');
    const tenant = await user(0.25);
    const service = budgets();
    await service.releaseExpired(); // the sweep is global: clear what earlier tests left open
    await service.reserve(tenant, randomUUID());

    now = new Date('2101-05-13T08:04:00Z');
    expect(await service.releaseExpired()).toBe(0);
    now = new Date('2101-05-13T08:06:00Z');
    expect(await service.releaseExpired()).toBe(1);

    expect((await usage(tenant))[0]?.reserved).toBe(0);
  });

  describe('through the chat endpoint', () => {
    const ai = new FakeAiServer();
    let app: INestApplication;
    let base: string;

    beforeAll(async () => {
      await ai.start();
      ({ app, base } = await startDbTestApp('budget.test'));
    });

    afterAll(async () => {
      await app.close();
      await ai.stop();
    });

    /** A signed-in user with one ready document and an empty conversation. */
    const chatUser = async () => {
      const sub = randomUUID();
      const call = userClient(base, sub);
      await call('GET', '/api/me');
      await db.query(
        `INSERT INTO documents (tenant_id, title, original_filename, s3_key, size_bytes, status)
         VALUES ($1, 'Handbook', 'h.pdf', 'k', 1, 'ready')`,
        [sub],
      );
      const { id } = (await (await call('POST', '/api/conversations', {})).json()) as {
        id: string;
      };
      const ask = (content: string) =>
        call('POST', `/api/conversations/${id}/messages`, {
          clientMessageId: randomUUID(),
          content,
        });
      return { sub, conversationId: id, ask };
    };

    it('refuses with 429, Retry-After and no stored messages when the user is over the limit', async () => {
      const u = await chatUser();
      await db.query('UPDATE users SET daily_limit_usd = 0.0001 WHERE id = $1', [u.sub]);
      const callsBefore = ai.requests.length;

      const res = await u.ask('How many days of annual leave do I get?');

      expect(res.status).toBe(429);
      expect(res.headers.get('content-type')).toMatch(/problem\+json/);
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(25 * 3600);
      expect(await res.json()).toMatchObject({ code: 'BUDGET_EXCEEDED', scope: 'user' });
      expect(ai.requests.length).toBe(callsBefore);
      const { rows } = await db.query('SELECT 1 FROM messages WHERE conversation_id = $1', [
        u.conversationId,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('holds the estimate while answering and releases it when the stream ends', async () => {
      const u = await chatUser();

      const text = await (await u.ask('How many days of annual leave do I get?')).text();

      expect(text).toContain('event: done');
      const { rows } = await db.query<{ released: boolean; reserved: number }>(
        `SELECT r.released_at IS NOT NULL AS released, d.reserved_usd::float8 AS reserved
           FROM budget_reservations r
           JOIN user_daily_usage d ON d.tenant_id = r.tenant_id AND d.day = r.day
          WHERE r.tenant_id = $1`,
        [u.sub],
      );
      expect(rows).toEqual([{ released: true, reserved: 0 }]);
    });
  });
});
