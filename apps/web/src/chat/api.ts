import {
  type FeedbackRequest,
  parseSseEvent,
  type SseEvent,
  type Source,
} from '@smartdoc/contracts';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { api, ApiError } from '../api';

export type MessageStatus =
  'streaming' | 'complete' | 'aborted' | 'error' | 'no_answer' | 'cached' | 'degraded';

/** A source as stored on the answer: `cited` says whether the text references it. */
export type Citation = Source & { cited: boolean };

export interface ConversationDto {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  citations: Citation[] | null;
  costUsd: number | null;
  latencyMs: { ttft: number | null; total: number | null } | null;
  rating: 1 | -1 | null;
  createdAt: string;
}

export interface ConversationDetail {
  conversation: ConversationDto;
  messages: MessageDto[];
}

type EventData<E extends SseEvent['event']> = Extract<SseEvent, { event: E }>['data'];
export type AckData = EventData<'ack'>;
export type DoneData = EventData<'done'>;
export type StreamErrorData = EventData<'error'>;

export const listConversations = (token: string) =>
  api<ConversationDto[]>('GET', '/conversations', token);

export const getConversation = (token: string, id: string) =>
  api<ConversationDetail>('GET', `/conversations/${id}`, token);

export const createConversation = (token: string) =>
  api<ConversationDto>('POST', '/conversations', token, {});

export const deleteConversation = (token: string, id: string) =>
  api<void>('DELETE', `/conversations/${id}`, token);

export const rateAnswer = (token: string, messageId: string, feedback: FeedbackRequest) =>
  api<void>('POST', `/messages/${messageId}/feedback`, token, feedback);

export const clearRating = (token: string, messageId: string) =>
  api<void>('DELETE', `/messages/${messageId}/feedback`, token);

export interface SendMessage {
  clientMessageId: string;
  content: string;
}

/** A repeated clientMessageId is answered from the database instead of a stream. */
export type SendResult = { kind: 'stream' } | { kind: 'replay'; assistantMessage: MessageDto };

/**
 * Sends a question and calls `onEvent` for every SSE event, validated against the shared
 * contract. Resolves when the stream ends; rejects with ApiError before the stream starts, or
 * with the fetch error (AbortError when `signal` fires) while it runs.
 */
export async function streamMessage(
  token: string,
  conversationId: string,
  body: SendMessage,
  signal: AbortSignal,
  onEvent: (event: SseEvent) => void,
): Promise<SendResult> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as
      { code?: string; detail?: string } | undefined;
    throw new ApiError(res.status, problem?.code ?? 'UNKNOWN', problem?.detail ?? res.statusText);
  }
  if (res.headers.get('content-type')?.includes('application/json')) {
    const replay = (await res.json()) as { assistantMessage: MessageDto };
    return { kind: 'replay', assistantMessage: replay.assistantMessage };
  }
  if (!res.body) {
    throw new ApiError(0, 'NETWORK', 'The response had no body');
  }

  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return { kind: 'stream' };
    }
    let event: SseEvent;
    try {
      event = parseSseEvent(value.event ?? 'message', value.data);
    } catch {
      continue; // Never render what breaks the contract; the API logs it.
    }
    onEvent(event);
  }
}

const SEND_MESSAGES: Record<string, string> = {
  NO_DOCUMENTS: 'Upload a document and wait until it is ready before asking.',
  IN_PROGRESS: 'This question is still being answered. Try again in a moment.',
  RATE_LIMITED: 'Too many questions in a short time. Wait a minute and try again.',
  NOT_FOUND: 'This conversation no longer exists. Start a new chat.',
  VALIDATION_FAILED: 'Questions are limited to 2,000 characters.',
  UNAVAILABLE: 'The service is temporarily unavailable. Try again in a minute.',
};

export function sendErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return SEND_MESSAGES[error.code] ?? error.message;
  }
  return 'Connection lost. Check your connection and try again.';
}
