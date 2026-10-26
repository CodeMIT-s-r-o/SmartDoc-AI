import { api } from '../api';

export interface SpendRow {
  day: string;
  purpose: string;
  costUsd: number;
  calls: number;
}

export interface Metrics {
  range: { from: string; to: string };
  spendByDay: SpendRow[];
  requests: {
    total: number;
    answered: number;
    refused: number;
    degraded: number;
    exactCacheHits: number;
    exactCacheHitRate: number;
    answeredP50Usd: number;
    meanUsd: number;
    totalUsd: number;
  };
  promptCache: {
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    cachedShare: number;
  };
  savings: { mechanism: string; basis: string; count: number; savedUsd: number }[];
}

export interface ThumbsDown {
  messageId: string;
  createdAt: string;
  question: string | null;
  answer: string;
  status: string;
  reasons: string[];
  comment: string | null;
  costUsd: number | null;
  requestId: string | null;
  traceId: string | null;
}

export interface Feedback {
  up: number;
  down: number;
  items: ThumbsDown[];
}

/** The last `days` days, today included, as the API's inclusive date range. */
export function lastDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

export const getMetrics = (token: string, range: { from: string; to: string }) =>
  api<Metrics>('GET', `/admin/metrics?from=${range.from}&to=${range.to}`, token);

export const getFeedback = (token: string) => api<Feedback>('GET', '/admin/feedback', token);
