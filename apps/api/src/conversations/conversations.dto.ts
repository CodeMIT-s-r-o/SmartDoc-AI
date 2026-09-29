import { z } from 'zod';
import type { Citation } from '../db/schema.js';
import type { ConversationRow, MessageRow } from './conversations.repository.js';

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
  createdAt: string;
}

export const toConversationDto = (row: ConversationRow): ConversationDto => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toMessageDto = (row: MessageRow): MessageDto => ({
  id: row.id,
  role: row.role,
  content: row.content,
  status: row.status,
  citations: row.citations ?? null,
  createdAt: row.createdAt.toISOString(),
});
