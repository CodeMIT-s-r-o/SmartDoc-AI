import { z } from 'zod';

/**
 * Chat stream contract (see docs/IMPLEMENTATION_PLAN.md §5.3).
 * Framing: `event: <name>\ndata: <json>\n\n`; exactly one terminal event (`done` or `error`).
 */

export const sourceSchema = z.object({
  n: z.number().int().positive(),
  chunkId: z.uuid(),
  documentId: z.uuid(),
  title: z.string(),
  section: z.string().nullable(),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  score: z.number(),
  snippet: z.string(),
});

export const ackSchema = z.object({
  requestId: z.uuid(),
  conversationId: z.uuid(),
  userMessageId: z.uuid(),
  assistantMessageId: z.uuid(),
});

export const metaSchema = z.object({
  requestId: z.uuid(),
  model: z.string(),
  promptVersion: z.string(),
  cache: z.enum(['miss', 'exact']),
  rewrittenQuestion: z.string().optional(),
});

export const tokenSchema = z.object({ d: z.string() });

export const doneStatusSchema = z.enum([
  'answered',
  'no_answer_gate',
  'no_answer_model',
  'cached',
  'degraded',
]);

export const doneSchema = z.object({
  status: doneStatusSchema,
  citedSources: z.array(z.number().int().positive()),
  citationsValid: z.boolean(),
  usage: z.object({
    input: z.number().int().nonnegative(),
    cached: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    embedding: z.number().int().nonnegative(),
  }),
  costUsd: z.number().nonnegative(),
  savedUsd: z.number().nonnegative(),
  latencyMs: z.object({
    retrieval: z.number().nonnegative().nullable(),
    ttft: z.number().nonnegative().nullable(),
    total: z.number().nonnegative(),
  }),
  abstained: z.boolean(),
  traceId: z.string().nullable(),
});

export const errorCodeSchema = z.enum([
  'UPSTREAM_TIMEOUT',
  'OPENAI_ERROR',
  'SCOPE_MISMATCH',
  'INTERNAL',
]);

export const errorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

export const sseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('ack'), data: ackSchema }),
  z.object({ event: z.literal('meta'), data: metaSchema }),
  z.object({ event: z.literal('sources'), data: z.array(sourceSchema) }),
  z.object({ event: z.literal('token'), data: tokenSchema }),
  z.object({ event: z.literal('done'), data: doneSchema }),
  z.object({ event: z.literal('error'), data: errorSchema }),
]);

export type Source = z.infer<typeof sourceSchema>;
export type DoneStatus = z.infer<typeof doneStatusSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
export type SseEventName = SseEvent['event'];

export const TERMINAL_EVENTS: ReadonlySet<SseEventName> = new Set(['done', 'error']);

/** Parses one SSE frame (event name + raw JSON data) into a validated, typed event. */
export function parseSseEvent(event: string, data: string): SseEvent {
  return sseEventSchema.parse({ event, data: JSON.parse(data) as unknown });
}
