import type { DoneStatus, SseEvent, Source } from '@smartdoc/contracts';
import type { AckData, Citation, DoneData, MessageDto, MessageStatus } from './api';

/** The question being answered right now, built from the stream. */
export interface LiveTurn {
  clientMessageId: string;
  question: string;
  ack?: AckData;
  text: string;
  sources: Source[];
  done?: DoneData;
  error?: string;
  stopped: boolean;
  running: boolean;
}

/** One answer, from the stream or from the database: what the UI renders. */
export interface AnswerView {
  messageId: string | null;
  text: string;
  status: MessageStatus;
  /** While streaming: nothing yet, sources arrived, or tokens are coming in. */
  phase: 'searching' | 'reading' | 'writing' | null;
  citations: Citation[];
  costUsd: number | null;
  latencyMs: { ttft: number | null; total: number | null } | null;
  usage: DoneData['usage'] | null;
  rating: 1 | -1 | null;
  error: string | null;
}

export const DONE_STATUS: Record<DoneStatus, MessageStatus> = {
  answered: 'complete',
  no_answer_gate: 'no_answer',
  no_answer_model: 'no_answer',
  cached: 'cached',
  degraded: 'degraded',
};

export const RATEABLE: ReadonlySet<MessageStatus> = new Set([
  'complete',
  'cached',
  'no_answer',
  'degraded',
]);

export function applyEvent(turn: LiveTurn, event: SseEvent): LiveTurn {
  switch (event.event) {
    case 'ack':
      return { ...turn, ack: event.data };
    case 'sources':
      return { ...turn, sources: event.data };
    case 'token':
      return { ...turn, text: turn.text + event.data.d };
    case 'done':
      return { ...turn, done: event.data };
    case 'error':
      return { ...turn, error: event.data.message };
    default:
      return turn;
  }
}

function liveStatus(turn: LiveTurn): MessageStatus {
  if (turn.error) {
    return 'error';
  }
  if (turn.done) {
    return DONE_STATUS[turn.done.status];
  }
  if (turn.stopped) {
    return 'aborted';
  }
  return turn.running ? 'streaming' : 'error';
}

export function fromLive(turn: LiveTurn): AnswerView {
  const status = liveStatus(turn);
  const cited = new Set(turn.done?.citedSources ?? []);
  let phase: AnswerView['phase'] = null;
  if (status === 'streaming') {
    phase = turn.text ? 'writing' : turn.sources.length > 0 ? 'reading' : 'searching';
  }
  return {
    messageId: turn.ack?.assistantMessageId ?? null,
    text: turn.text,
    status,
    phase,
    citations: turn.sources.map((s) => ({ ...s, cited: cited.has(s.n) })),
    costUsd: turn.done?.costUsd ?? null,
    latencyMs: turn.done ? turn.done.latencyMs : null,
    usage: turn.done?.usage ?? null,
    rating: null,
    error:
      status === 'error'
        ? (turn.error ?? 'The connection dropped before the answer finished.')
        : null,
  };
}

export const fromMessage = (message: MessageDto): AnswerView => ({
  messageId: message.id,
  text: message.content,
  status: message.status,
  phase: message.status === 'streaming' ? 'writing' : null,
  citations: message.citations ?? [],
  costUsd: message.costUsd,
  latencyMs: message.latencyMs,
  usage: null,
  rating: message.rating,
  error: message.status === 'error' ? 'The answer could not be completed.' : null,
});

export type ChatItem =
  | { kind: 'question'; key: string; text: string }
  | { kind: 'answer'; key: string; answer: AnswerView; question: string };

/**
 * Stored messages, then the live turn until the database has its final version (the stream's
 * copy is shown while the stored answer is missing or still `streaming`).
 */
export function chatItems(messages: MessageDto[], live: LiveTurn | null): ChatItem[] {
  const liveIds = new Set(live?.ack ? [live.ack.userMessageId, live.ack.assistantMessageId] : []);
  const settled = messages.some(
    (m) => m.id === live?.ack?.assistantMessageId && m.status !== 'streaming',
  );
  const showLive = live !== null && !settled;
  const items: ChatItem[] = [];
  let question = '';
  for (const m of messages) {
    if (showLive && liveIds.has(m.id)) {
      continue;
    }
    if (m.role === 'user') {
      question = m.content;
      items.push({ kind: 'question', key: m.id, text: m.content });
    } else {
      items.push({ kind: 'answer', key: m.id, answer: fromMessage(m), question });
    }
  }
  if (showLive) {
    items.push({ kind: 'question', key: `live-q-${live.clientMessageId}`, text: live.question });
    items.push({
      kind: 'answer',
      key: `live-a-${live.clientMessageId}`,
      answer: fromLive(live),
      question: live.question,
    });
  }
  return items;
}
