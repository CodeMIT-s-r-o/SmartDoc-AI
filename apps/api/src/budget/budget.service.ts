import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import { DB, type Database } from '../db/db.module.js';

export const CLOCK = Symbol('CLOCK');
/** Injectable "now", so tests can freeze time around midnight. */
export type Clock = () => Date;

/**
 * Worst case for one answer, priced at the full input rate (no cache credit): the 1.3k static
 * prefix + 2,000 context + 800 history + a 2,000-character question, and max_output_tokens.
 */
export const ESTIMATE_INPUT_TOKENS = 4_600;
export const ESTIMATE_OUTPUT_TOKENS = 600;
/** Longer than any stream (120 s), so only a crashed request ever reaches it. */
const RESERVATION_TTL_MS = 5 * 60_000;
const BUDGET_ZONE = 'Europe/Bratislava';

export type BudgetScope = 'user' | 'app';

export class BudgetExceeded extends Error {
  constructor(
    readonly scope: BudgetScope,
    /** The next midnight in Europe/Bratislava, when both budgets start over. */
    readonly resetsAt: Date,
    /** Whole seconds until then, for the Retry-After header. */
    readonly retryAfterS: number,
  ) {
    super(`${scope} daily budget exceeded`);
  }
}

interface ReservationContext {
  day: string;
  resets_at: Date;
  est_usd: string;
}

/**
 * Daily budgets with reservations (docs/IMPLEMENTATION_PLAN.md §7). A chat request holds its
 * worst-case cost before calling the AI service and releases it when the stream ends; the ledger
 * trigger has already moved the real cost into spent_usd by then. Lock order everywhere (here and
 * in the ledger trigger): the user's row, then the app row, so the two never deadlock.
 */
@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);
  private readonly globalCapUsd: number;
  private readonly chatModel: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    config: ConfigService<Env, true>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.globalCapUsd = config.get('GLOBAL_DAILY_CAP_USD', { infer: true });
    this.chatModel = config.get('RAG_CHAT_MODEL', { infer: true });
  }

  /**
   * One READ COMMITTED transaction. The conditional UPDATEs take the row lock and Postgres
   * re-checks their WHERE against the newest row version, so concurrent requests can never
   * reserve past the limit. Throws BudgetExceeded (everything rolled back) when a cap is hit.
   */
  async reserve(tenantId: string, requestId: string): Promise<void> {
    const now = this.clock();
    await this.db.transaction(async (tx) => {
      const {
        rows: [ctx],
      } = await tx.execute<ReservationContext & Record<string, unknown>>(sql`
        SELECT (${now}::timestamptz AT TIME ZONE ${BUDGET_ZONE})::date::text AS day,
               (date_trunc('day', ${now}::timestamptz AT TIME ZONE ${BUDGET_ZONE})
                  + interval '1 day') AT TIME ZONE ${BUDGET_ZONE} AS resets_at,
               (${ESTIMATE_INPUT_TOKENS} * input_usd_per_mtok
                  + ${ESTIMATE_OUTPUT_TOKENS} * output_usd_per_mtok) / 1000000 AS est_usd
          FROM model_prices
         WHERE model = ${this.chatModel} AND service_tier = 'default'
           AND tstzrange(effective_from, effective_to) @> ${now}::timestamptz`);
      if (!ctx) {
        throw new Error(`no price for chat model ${this.chatModel}`);
      }
      const { day, est_usd: est } = ctx;
      const resetsAt = new Date(ctx.resets_at);
      const exceeded = (scope: BudgetScope) =>
        new BudgetExceeded(
          scope,
          resetsAt,
          Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)),
        );

      // First request of the day: make sure both rows exist before the conditional UPDATEs.
      await tx.execute(sql`
        INSERT INTO user_daily_usage (tenant_id, day) VALUES (${tenantId}, ${day})
        ON CONFLICT DO NOTHING`);
      await tx.execute(
        sql`INSERT INTO app_daily_usage (day) VALUES (${day}) ON CONFLICT DO NOTHING`,
      );

      const user = await tx.execute(sql`
        UPDATE user_daily_usage SET reserved_usd = reserved_usd + ${est}::numeric
         WHERE tenant_id = ${tenantId} AND day = ${day}
           AND spent_usd + reserved_usd + ${est}::numeric
               <= (SELECT daily_limit_usd FROM users WHERE id = ${tenantId})
        RETURNING 1`);
      if (user.rowCount === 0) {
        throw exceeded('user');
      }
      const app = await tx.execute(sql`
        UPDATE app_daily_usage SET reserved_usd = reserved_usd + ${est}::numeric
         WHERE day = ${day} AND spent_usd + reserved_usd + ${est}::numeric <= ${this.globalCapUsd}
        RETURNING 1`);
      if (app.rowCount === 0) {
        throw exceeded('app');
      }
      await tx.execute(sql`
        INSERT INTO budget_reservations (request_id, tenant_id, day, est_usd, created_at, expires_at)
        VALUES (${requestId}, ${tenantId}, ${day}, ${est}::numeric, ${now}::timestamptz,
                ${new Date(now.getTime() + RESERVATION_TTL_MS)}::timestamptz)`);
    });
  }

  /**
   * Idempotent, and charged back to the reservation's stored day, so a request that started
   * before midnight releases yesterday's budget, not today's. False when there was nothing open.
   */
  async release(requestId: string): Promise<boolean> {
    const now = this.clock();
    return this.db.transaction(async (tx) => {
      const {
        rows: [held],
      } = await tx.execute<{ tenant_id: string; day: string; est_usd: string }>(sql`
        UPDATE budget_reservations SET released_at = ${now}::timestamptz
         WHERE request_id = ${requestId} AND released_at IS NULL
        RETURNING tenant_id, day::text AS day, est_usd`);
      if (!held) {
        return false;
      }
      await tx.execute(sql`
        UPDATE user_daily_usage SET reserved_usd = reserved_usd - ${held.est_usd}::numeric
         WHERE tenant_id = ${held.tenant_id} AND day = ${held.day}`);
      await tx.execute(sql`
        UPDATE app_daily_usage SET reserved_usd = reserved_usd - ${held.est_usd}::numeric
         WHERE day = ${held.day}`);
      return true;
    });
  }

  /** Releases reservations whose request crashed before it could release them itself. */
  async releaseExpired(): Promise<number> {
    const { rows } = await this.db.execute<{ request_id: string }>(sql`
      SELECT request_id FROM budget_reservations
       WHERE released_at IS NULL AND expires_at < ${this.clock()}::timestamptz
       ORDER BY expires_at
       LIMIT 100`);
    let released = 0;
    for (const { request_id: requestId } of rows) {
      if (await this.release(requestId)) {
        released += 1;
      }
    }
    if (released > 0) {
      this.logger.warn(`released ${released} expired budget reservation(s)`);
    }
    return released;
  }
}
