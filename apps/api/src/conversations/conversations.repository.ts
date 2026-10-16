import { Inject, Injectable } from '@nestjs/common';
import type { FeedbackRequest } from '@smartdoc/contracts';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../common/pg-errors.js';
import { DB, type Database } from '../db/db.module.js';
import {
  type Citation,
  conversations,
  documents,
  feedback,
  messages,
  ragRequests,
} from '../db/schema.js';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageStatus = MessageRow['status'];

/** A message as the UI shows it: the answer's cost and latency, and the user's rating. */
export interface MessageView extends MessageRow {
  costUsd: string | null;
  ttftMs: number | null;
  totalMs: number | null;
  rating: number | null;
}

export interface Turn {
  user: MessageRow;
  assistant: MessageRow | undefined;
}

/** Assistant statuses whose content is a real answer worth feeding back as history. */
const HISTORY_STATUSES: MessageStatus[] = ['complete', 'cached', 'no_answer'];
const TITLE_CHARS = 80;

export class DuplicateClientMessage extends Error {}

@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(tenantId: string, title: string | null): Promise<ConversationRow> {
    const [row] = await this.db.insert(conversations).values({ tenantId, title }).returning();
    return row!;
  }

  list(tenantId: string, limit: number): Promise<ConversationRow[]> {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.tenantId, tenantId))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);
  }

  async findOwned(tenantId: string, id: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId)));
    return row;
  }

  async rename(tenantId: string, id: string, title: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId)))
      .returning();
    return row;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenantId)))
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  async listMessages(conversationId: string): Promise<MessageView[]> {
    const rows = await this.db
      .select({
        message: messages,
        costUsd: ragRequests.costUsd,
        ttftMs: ragRequests.ttftMs,
        totalMs: ragRequests.totalMs,
        rating: feedback.rating,
      })
      .from(messages)
      // The user message carries the same rag_request_id; only the answer shows the cost.
      .leftJoin(
        ragRequests,
        and(eq(ragRequests.id, messages.ragRequestId), eq(messages.role, 'assistant')),
      )
      .leftJoin(feedback, eq(feedback.messageId, messages.id))
      .where(eq(messages.conversationId, conversationId))
      // Both rows of a turn share created_at (now() is the transaction start): 'user' sorts after
      // 'assistant', so the question comes first only with role descending.
      .orderBy(asc(messages.createdAt), desc(messages.role));
    return rows.map(({ message, ...extras }) => ({ ...message, ...extras }));
  }

  /** A turn is a user message and the assistant message sharing its rag_request_id. */
  async findTurn(conversationId: string, clientMessageId: string): Promise<Turn | undefined> {
    const [user] = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.clientMessageId, clientMessageId),
        ),
      );
    if (!user?.ragRequestId) {
      return undefined;
    }
    const [assistant] = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.ragRequestId, user.ragRequestId),
          eq(messages.role, 'assistant'),
        ),
      );
    return { user, assistant };
  }

  /** The most recent answered turns, oldest first (the AI service trims to its token budget). */
  async history(conversationId: string, limit: number): Promise<MessageRow[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          sql`(${messages.role} = 'user' OR ${inArray(messages.status, HISTORY_STATUSES)})`,
        ),
      )
      // Newest first, and within a turn the answer before its question (see listMessages).
      .orderBy(desc(messages.createdAt), asc(messages.role))
      .limit(limit);
    return rows.reverse();
  }

  /**
   * One transaction: the user message (idempotency key), the assistant message pre-created as
   * `streaming`, the conversation's title (first question) and its updated_at.
   */
  async insertTurn(input: {
    tenantId: string;
    conversationId: string;
    clientMessageId: string;
    content: string;
    requestId: string;
  }): Promise<{ userMessageId: string; assistantMessageId: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(messages)
          .values({
            conversationId: input.conversationId,
            tenantId: input.tenantId,
            role: 'user',
            clientMessageId: input.clientMessageId,
            content: input.content,
            status: 'complete',
            ragRequestId: input.requestId,
          })
          .returning({ id: messages.id });
        const [assistant] = await tx
          .insert(messages)
          .values({
            conversationId: input.conversationId,
            tenantId: input.tenantId,
            role: 'assistant',
            status: 'streaming',
            ragRequestId: input.requestId,
          })
          .returning({ id: messages.id });
        await tx
          .update(conversations)
          .set({
            title: sql`coalesce(${conversations.title}, ${input.content.slice(0, TITLE_CHARS)})`,
          })
          .where(eq(conversations.id, input.conversationId));
        return { userMessageId: user!.id, assistantMessageId: assistant!.id };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateClientMessage();
      }
      throw error;
    }
  }

  /** Only a message that is still streaming is finalized (the housekeeping tick may have won). */
  async finalize(
    assistantMessageId: string,
    update: { content: string; status: MessageStatus; citations: Citation[] | null },
  ): Promise<boolean> {
    const rows = await this.db
      .update(messages)
      .set(update)
      .where(and(eq(messages.id, assistantMessageId), eq(messages.status, 'streaming')))
      .returning({ id: messages.id });
    return rows.length > 0;
  }

  /** Streaming messages whose request died with its process: close them as errors. */
  async failStaleStreaming(olderThan: Date): Promise<number> {
    const rows = await this.db
      .update(messages)
      .set({ status: 'error' })
      .where(and(eq(messages.status, 'streaming'), lt(messages.createdAt, olderThan)))
      .returning({ id: messages.id });
    return rows.length;
  }

  async readyDocumentIds(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.status, 'ready')));
    return rows.map((r) => r.id);
  }

  /** Every requested id must be one of the tenant's ready documents. */
  async ownsReadyDocuments(tenantId: string, ids: string[]): Promise<boolean> {
    const ready = new Set(await this.readyDocumentIds(tenantId));
    return ids.every((id) => ready.has(id));
  }

  /** Upserts the caller's rating of a finished answer; false when there is no such answer. */
  async saveFeedback(tenantId: string, messageId: string, body: FeedbackRequest): Promise<boolean> {
    const answer = await this.findRateable(tenantId, messageId);
    if (!answer) {
      return false;
    }
    const values = {
      rating: body.rating,
      reasons: body.reasons?.length ? body.reasons : null,
      comment: body.comment || null,
    };
    await this.db
      .insert(feedback)
      .values({ messageId, tenantId, requestId: answer.ragRequestId, ...values })
      .onConflictDoUpdate({ target: feedback.messageId, set: values });
    return true;
  }

  async deleteFeedback(tenantId: string, messageId: string): Promise<boolean> {
    if (!(await this.findRateable(tenantId, messageId))) {
      return false;
    }
    await this.db.delete(feedback).where(eq(feedback.messageId, messageId));
    return true;
  }

  private async findRateable(tenantId: string, messageId: string) {
    const [answer] = await this.db
      .select({ ragRequestId: messages.ragRequestId })
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.tenantId, tenantId),
          eq(messages.role, 'assistant'),
          ne(messages.status, 'streaming'),
        ),
      );
    return answer;
  }
}
