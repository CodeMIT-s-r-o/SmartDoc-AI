import { z } from 'zod';
import type { Citation } from '../db/schema.js';
import type { ConversationRow, MessageRow, MessageView } from './conversations.repository.js';

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
});
export const renameConversationSchema = z.object({ title: z.string().trim().min(1).max(120) });

export const sendMessageSchema = z.object({
  /** Client-generated idempotency key: a retried send never triggers a second LLM call. */
  clientMessageId: z.uuid(),
  content: z.string().trim().min(1).max(2000),
  /** Defaults to all of the caller's ready documents. */
  documentIds: z.array(z.uuid()).min(1).max(50).optional(),
});
export type SendMessageBody = z.infer<typeof sendMessageSchema>;

export interface ConversationDto {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: MessageRow['role'];
  content: string;
  status: MessageRow['status'];
  citations: Citation[] | null;
  /** Answers only: what the request cost (ledger total) and how long it took. */
  costUsd: number | null;
  latencyMs: { ttft: number | null; total: number | null } | null;
  rating: 1 | -1 | null;
  createdAt: string;
}

export const toConversationDto = (row: ConversationRow): ConversationDto => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toMessageDto = (row: MessageRow | MessageView): MessageDto => {
  const view: Partial<MessageView> = row;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    citations: row.citations ?? null,
    costUsd: view.costUsd == null ? null : Number(view.costUsd),
    latencyMs:
      view.totalMs == null && view.ttftMs == null
        ? null
        : { ttft: view.ttftMs ?? null, total: view.totalMs ?? null },
    rating: view.rating === 1 || view.rating === -1 ? view.rating : null,
    createdAt: row.createdAt.toISOString(),
  };
};
