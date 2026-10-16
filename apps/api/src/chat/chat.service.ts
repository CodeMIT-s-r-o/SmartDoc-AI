import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context.js';
import { BudgetExceeded, BudgetService } from '../budget/budget.service.js';
import { ProblemException } from '../common/problem.js';
import {
  ConversationsRepository,
  DuplicateClientMessage,
  type MessageStatus,
  type Turn,
} from '../conversations/conversations.repository.js';
import { type SendMessageBody, toMessageDto } from '../conversations/conversations.dto.js';
import type { Citation } from '../db/schema.js';
import { AiClient } from './ai-client.js';
import { type SseResponse, startSse, writeEvent } from './sse-response.js';
import { MESSAGE_STATUS, StreamCollector } from './stream-collector.js';

/** Messages sent as history (the AI service trims them to its token budget). */
const HISTORY_MESSAGES = 6;
/** Upper bound for one answer; the AI service has its own per-stage timeouts. */
const STREAM_TIMEOUT_MS = 120_000;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly repo: ConversationsRepository,
    private readonly ai: AiClient,
    private readonly budget: BudgetService,
  ) {}

  /**
   * Sends a question and streams the answer. Everything that can be rejected is checked before
   * the first byte (so errors are ordinary problem+json responses); after that, failures become
   * an SSE `error` event and the assistant message records what happened.
   */
  async send(
    auth: AuthContext,
    conversationId: string,
    body: SendMessageBody,
    res: SseResponse,
  ): Promise<void> {
    const conversation = await this.repo.findOwned(auth.tenantId, conversationId);
    if (!conversation) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Conversation not found');
    }

    const previous = await this.repo.findTurn(conversationId, body.clientMessageId);
    if (previous) {
      return this.replay(previous, res);
    }

    const documentIds = body.documentIds ?? (await this.repo.readyDocumentIds(auth.tenantId));
    if (documentIds.length === 0) {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'NO_DOCUMENTS',
        'Upload a document and wait until it is ready before asking questions',
      );
    }
    if (body.documentIds && !(await this.repo.ownsReadyDocuments(auth.tenantId, documentIds))) {
      throw new ProblemException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Document not found');
    }

    const requestId = randomUUID();
    // The last check before the first byte: a refusal is still a plain 429 problem+json.
    await this.reserveBudget(auth.tenantId, requestId);
    let history: Awaited<ReturnType<ConversationsRepository['history']>>;
    let turn: { userMessageId: string; assistantMessageId: string };
    try {
      history = await this.repo.history(conversationId, HISTORY_MESSAGES);
      turn = await this.repo.insertTurn({
        tenantId: auth.tenantId,
        conversationId,
        clientMessageId: body.clientMessageId,
        content: body.content,
        requestId,
      });
    } catch (error) {
      await this.releaseBudget(requestId);
      if (error instanceof DuplicateClientMessage) {
        // A concurrent retry of the same send won the insert: behave as if it arrived first.
        const winner = await this.repo.findTurn(conversationId, body.clientMessageId);
        if (winner) {
          return this.replay(winner, res);
        }
      }
      throw error;
    }

    try {
      await this.stream(res, {
        requestId,
        conversationId,
        assistantMessageId: turn.assistantMessageId,
        userMessageId: turn.userMessageId,
        aiRequest: {
          requestId,
          tenantId: auth.tenantId,
          conversationId,
          question: body.content,
          history: history.map((m) => ({ role: m.role, content: m.content })),
          documentIds,
          bypassCache: body.bypassCache ?? false,
        },
      });
    } finally {
      // The AI service wrote its ledger rows before its stream ended, so spend is already
      // counted; whatever the outcome, the estimate stops being held. Released before the
      // response ends, so the client's next question already sees the freed budget.
      await this.releaseBudget(requestId);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private async reserveBudget(tenantId: string, requestId: string): Promise<void> {
    try {
      await this.budget.reserve(tenantId, requestId);
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) {
        throw error;
      }
      throw new ProblemException(
        HttpStatus.TOO_MANY_REQUESTS,
        'BUDGET_EXCEEDED',
        error.scope === 'user'
          ? "You have used today's AI budget. It resets at midnight (Europe/Bratislava)."
          : "SmartDoc's daily AI budget is used up. It resets at midnight (Europe/Bratislava).",
        { scope: error.scope, resetsAt: error.resetsAt.toISOString() },
        { 'Retry-After': String(error.retryAfterS) },
      );
    }
  }

  /** Never fails the request: an unreleased reservation expires and the housekeeping tick frees it. */
  private async releaseBudget(requestId: string): Promise<void> {
    try {
      await this.budget.release(requestId);
    } catch (error) {
      this.logger.warn(`request ${requestId}: budget release failed: ${String(error)}`);
    }
  }

  /** The same clientMessageId again: never a second LLM call. */
  private replay(turn: Turn, res: SseResponse): void {
    if (!turn.assistant || turn.assistant.status === 'streaming') {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'IN_PROGRESS',
        'This message is still being answered',
      );
    }
    res.status(200).json({
      userMessage: toMessageDto(turn.user),
      assistantMessage: toMessageDto(turn.assistant),
    });
  }

  private async stream(
    res: SseResponse,
    turn: {
      requestId: string;
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      aiRequest: Parameters<AiClient['openChat']>[0];
    },
  ): Promise<void> {
    const controller = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });

    startSse(res);
    writeEvent(res, 'ack', {
      requestId: turn.requestId,
      conversationId: turn.conversationId,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
    });

    const collector = new StreamCollector();
    try {
      const upstream = await this.ai.openChat(
        turn.aiRequest,
        AbortSignal.any([controller.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]),
      );
      // One read loop: every chunk goes to the browser as-is and into the collector.
      for await (const chunk of upstream) {
        res.write(chunk);
        collector.feed(chunk);
      }
    } catch (error) {
      if (!clientGone) {
        this.logger.warn(`request ${turn.requestId}: AI stream failed: ${String(error)}`);
      }
    }

    if (!clientGone && !collector.terminal) {
      writeEvent(res, 'error', {
        code: 'UPSTREAM_TIMEOUT',
        message: 'The answer could not be completed. Try again.',
        retryable: true,
      });
    }
    await this.finalize(turn.assistantMessageId, collector, clientGone);
  }

  private async finalize(
    assistantMessageId: string,
    collector: StreamCollector,
    clientGone: boolean,
  ): Promise<void> {
    let status: MessageStatus;
    if (collector.done) {
      status = MESSAGE_STATUS[collector.done.status];
    } else if (clientGone) {
      status = 'aborted';
    } else {
      status = 'error';
    }
    if (collector.invalidEvents > 0) {
      // The bytes were forwarded anyway; the contract test in CI should have caught this.
      this.logger.warn(
        `message ${assistantMessageId}: ${collector.invalidEvents} events broke the SSE contract`,
      );
    }
    const cited = new Set(collector.done?.citedSources ?? []);
    const citations: Citation[] | null =
      collector.sources.length > 0
        ? collector.sources.map((s) => ({ ...s, cited: cited.has(s.n) }))
        : null;
    try {
      await this.repo.finalize(assistantMessageId, { content: collector.text, status, citations });
    } catch (error) {
      this.logger.error(`could not finalize message ${assistantMessageId}: ${String(error)}`);
    }
  }
}
