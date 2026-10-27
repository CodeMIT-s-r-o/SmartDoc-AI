import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';

const ZONE = 'Europe/Bratislava';

export interface Range {
  from: Date;
  to: Date;
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/**
 * Aggregates for the Cost page, read from the ledger (llm_calls), the request telemetry
 * (rag_requests), booked savings (cost_savings) and feedback. Across all tenants: admin only.
 */
@Injectable()
export class AdminRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.db.execute<Row>(query)).rows;
  }

  async metrics({ from, to }: Range) {
    const [spendByDay, requests, cache, savings] = await Promise.all([
      this.rows(sql`
        SELECT (created_at AT TIME ZONE ${ZONE})::date::text AS day, purpose,
               sum(cost_usd)::float8 AS cost_usd, count(*)::int AS calls
          FROM llm_calls
         WHERE created_at >= ${from} AND created_at < ${to}
         GROUP BY 1, 2 ORDER BY 1, 2`),
      this.rows(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE cache_type = 'exact')::int AS exact_hits,
               count(*) FILTER (WHERE status = 'answered')::int AS answered,
               count(*) FILTER (WHERE status IN ('no_answer_gate', 'no_answer_model'))::int AS refused,
               count(*) FILTER (WHERE status = 'degraded')::int AS degraded,
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)
                  FILTER (WHERE status = 'answered'))::float8 AS answered_p50_usd,
               avg(cost_usd)::float8 AS mean_usd,
               coalesce(sum(cost_usd), 0)::float8 AS total_usd
          FROM rag_requests
         WHERE created_at >= ${from} AND created_at < ${to}`),
      this.rows(sql`
        SELECT coalesce(sum(input_tokens), 0)::bigint AS input,
               coalesce(sum(cached_tokens), 0)::bigint AS cached,
               coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write
          FROM llm_calls
         WHERE purpose = 'chat' AND created_at >= ${from} AND created_at < ${to}`),
      this.rows(sql`
        SELECT mechanism, basis, count(*)::int AS count, sum(saved_usd)::float8 AS saved_usd
          FROM cost_savings
         WHERE created_at >= ${from} AND created_at < ${to}
         GROUP BY 1, 2 ORDER BY 1`),
    ]);
    const r = requests[0] ?? {};
    const c = cache[0] ?? {};
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      spendByDay: spendByDay.map((row) => ({
        day: String(row.day),
        purpose: String(row.purpose),
        costUsd: num(row.cost_usd),
        calls: num(row.calls),
      })),
      requests: {
        total: num(r.total),
        answered: num(r.answered),
        refused: num(r.refused),
        degraded: num(r.degraded),
        exactCacheHits: num(r.exact_hits),
        exactCacheHitRate: num(r.total) ? num(r.exact_hits) / num(r.total) : 0,
        answeredP50Usd: num(r.answered_p50_usd),
        meanUsd: num(r.mean_usd),
        totalUsd: num(r.total_usd),
      },
      promptCache: {
        inputTokens: num(c.input),
        cachedTokens: num(c.cached),
        cacheWriteTokens: num(c.cache_write),
        cachedShare: num(c.input) ? num(c.cached) / num(c.input) : 0,
      },
      savings: savings.map((row) => ({
        mechanism: String(row.mechanism),
        basis: String(row.basis),
        count: num(row.count),
        savedUsd: num(row.saved_usd),
      })),
    };
  }

  /** Thumbs-downs, newest first, with the question they answered and what the answer cost. */
  async thumbsDown(limit: number) {
    const rows = await this.rows(sql`
      SELECT f.message_id, f.created_at, f.reasons, f.comment, a.content AS answer, a.status,
             (SELECT q.content FROM messages q
               WHERE q.conversation_id = a.conversation_id AND q.role = 'user'
                 AND q.rag_request_id = a.rag_request_id LIMIT 1) AS question,
             r.cost_usd::float8 AS cost_usd, r.trace_id, f.request_id
        FROM feedback f
        JOIN messages a ON a.id = f.message_id
        LEFT JOIN rag_requests r ON r.id = f.request_id
       WHERE f.rating = -1
       ORDER BY f.created_at DESC
       LIMIT ${limit}`);
    const [counts] = await this.rows(sql`
      SELECT count(*) FILTER (WHERE rating = 1)::int AS up,
             count(*) FILTER (WHERE rating = -1)::int AS down
        FROM feedback`);
    return {
      up: num(counts?.up),
      down: num(counts?.down),
      items: rows.map((row) => ({
        messageId: String(row.message_id),
        createdAt: new Date(row.created_at as string).toISOString(),
        question: (row.question as string | null) ?? null,
        answer: String(row.answer ?? '').slice(0, 500),
        status: String(row.status),
        reasons: (row.reasons as string[] | null) ?? [],
        comment: (row.comment as string | null) ?? null,
        costUsd: row.cost_usd === null ? null : num(row.cost_usd),
        requestId: (row.request_id as string | null) ?? null,
        traceId: (row.trace_id as string | null) ?? null,
      })),
    };
  }
}
