import type { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { BudgetExceeded, BudgetService } from '../../src/budget/budget.service.js';
import type { Env } from '../../src/config/env.js';
import * as schema from '../../src/db/schema.js';

/**
 * The budget figures published in the first LinkedIn post (October 2026), each reproduced here.
 *
 * If one of these fails, the code has changed under a published sentence: fix the code, or
 * correct the post. The naive implementation at the bottom exists only to measure what the real
 * BudgetService prevents; nothing in src/ uses it.
 */
const PUBLISHED = {
  /** "Daily budget $0.0027" */
  limitUsd: 0.0027,
  /** "room for 3 requests reserved at $0.00076 each": the worst case, not what an answer costs */
  estimateUsd: 0.00076,
  /** "exactly 3 get through" */
  accepted: 3,
  /** "all 10 do — 2.8× over budget" */
  naiveAccepted: 10,
  naiveOverrun: 2.8,
};

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('figures published about the budget (Postgres)', () => {
  const db = new pg.Pool({ connectionString: url, max: 2 });
  // Wide enough that all 10 requests really hold a connection at the same time.
  const servicePool = new pg.Pool({ connectionString: url, max: 12 });
  const orm = drizzle({ client: servicePool, schema, casing: 'snake_case' });
  // A day far in the future keeps these rows apart from every other test's.
  const now = new Date('2102-03-01T08:00:00Z');
  const day = '2102-03-01';

  const budgets = () =>
    new BudgetService(
      orm,
      {
        get: (key: keyof Env) =>
          ({ GLOBAL_DAILY_CAP_USD: 1000, RAG_CHAT_MODEL: 'gpt-6-luna' })[key as string],
      } as unknown as ConfigService<Env, true>,
      () => now,
    );

  const user = async (dailyLimitUsd: number) => {
    const id = randomUUID();
    await db.query('INSERT INTO users (id, email, daily_limit_usd) VALUES ($1, $2, $3)', [
      id,
      `${id}@post-claims.test`,
      dailyLimitUsd,
    ]);
    return id;
  };

  const reservedUsd = async (tenantId: string) =>
    (
      await db.query<{ reserved: number }>(
        `SELECT reserved_usd::float8 AS reserved FROM user_daily_usage
          WHERE tenant_id = $1 AND day = $2`,
        [tenantId, day],
      )
    ).rows[0]?.reserved ?? 0;

  afterAll(async () => {
    await db.query("DELETE FROM users WHERE email LIKE '%@post-claims.test'");
    await db.query('DELETE FROM app_daily_usage WHERE day = $1', [day]);
    await servicePool.end();
    await db.end();
  });

  it('reserves $0.00076 per request', async () => {
    const tenant = await user(0.25);
    const requestId = randomUUID();

    await budgets().reserve(tenant, requestId);

    const { rows } = await db.query<{ est: number }>(
      'SELECT est_usd::float8 AS est FROM budget_reservations WHERE request_id = $1',
      [requestId],
    );
    expect(rows[0]?.est).toBeCloseTo(PUBLISHED.estimateUsd, 10);
  });

  it('lets exactly 3 of 10 parallel requests through a $0.0027 budget, and reserves nothing for the rest', async () => {
    const tenant = await user(PUBLISHED.limitUsd);
    const service = budgets();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.reserve(tenant, randomUUID())),
    );

    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof BudgetExceeded,
    ).length;
    expect({ accepted, refused }).toEqual({ accepted: PUBLISHED.accepted, refused: 7 });

    // "$0.0023 reserved", within the limit.
    const reserved = await reservedUsd(tenant);
    expect(reserved).toBeCloseTo(PUBLISHED.accepted * PUBLISHED.estimateUsd, 10);
    expect(reserved).toBeLessThanOrEqual(PUBLISHED.limitUsd);

    // "0 rows → 429, nothing reserved": only the accepted requests hold a reservation.
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM budget_reservations WHERE tenant_id = $1',
      [tenant],
    );
    expect(rows[0]?.n).toBe(PUBLISHED.accepted);
  });

  it('naive check-then-act lets all 10 through: $0.0076, 2.8× the limit', async () => {
    const tenant = await user(PUBLISHED.limitUsd);
    await db.query('INSERT INTO user_daily_usage (tenant_id, day) VALUES ($1, $2)', [tenant, day]);
    const allHaveRead = barrier(10);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => naiveReserve(tenant, allHaveRead)),
    );

    expect(results.filter(Boolean)).toHaveLength(PUBLISHED.naiveAccepted);
    const reserved = await reservedUsd(tenant);
    expect(reserved).toBeCloseTo(PUBLISHED.naiveAccepted * PUBLISHED.estimateUsd, 10);
    expect(Number((reserved / PUBLISHED.limitUsd).toFixed(1))).toBe(PUBLISHED.naiveOverrun);
  });

  /**
   * The bug the real service avoids: read the balance, decide, then write unconditionally.
   * The barrier forces the interleaving the post describes — every request reads before any of
   * them writes — so the result is deterministic rather than dependent on scheduling luck. It
   * shows the logic flaw, not how often it bites under real traffic.
   */
  async function naiveReserve(tenantId: string, allHaveRead: Barrier): Promise<boolean> {
    const client = await servicePool.connect();
    try {
      const {
        rows: [balance],
      } = await client.query<{ used: string; daily_limit: string }>(
        `SELECT u.spent_usd + u.reserved_usd AS used, users.daily_limit_usd AS daily_limit
           FROM user_daily_usage u JOIN users ON users.id = u.tenant_id
          WHERE u.tenant_id = $1 AND u.day = $2`,
        [tenantId, day],
      );
      await allHaveRead.arriveAndWait();
      if (!balance || Number(balance.used) + PUBLISHED.estimateUsd > Number(balance.daily_limit)) {
        return false;
      }
      await client.query(
        `UPDATE user_daily_usage SET reserved_usd = reserved_usd + $3
          WHERE tenant_id = $1 AND day = $2`,
        [tenantId, day, PUBLISHED.estimateUsd],
      );
      return true;
    } finally {
      client.release();
    }
  }
});

interface Barrier {
  arriveAndWait(): Promise<void>;
}

/** Resolves for everyone once `parties` callers have arrived. */
function barrier(parties: number): Barrier {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    async arriveAndWait() {
      arrived += 1;
      if (arrived === parties) {
        open();
      }
      await gate;
    },
  };
}
