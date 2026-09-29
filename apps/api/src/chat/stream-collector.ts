import { type DoneStatus, parseSseEvent, type SseEvent, type Source } from '@smartdoc/contracts';
import { createParser, type EventSourceParser } from 'eventsource-parser';

/**
 * Reads the AI service's SSE stream as it is forwarded to the browser, validating every event
 * against the shared contract and keeping what the assistant message needs.
 */
export class StreamCollector {
  text = '';
  sources: Source[] = [];
  done: Extract<SseEvent, { event: 'done' }>['data'] | undefined;
  error: Extract<SseEvent, { event: 'error' }>['data'] | undefined;
  invalidEvents = 0;
  private readonly decoder = new TextDecoder();
  private readonly parser: EventSourceParser = createParser({
    onEvent: (message) => this.accept(message.event, message.data),
  });

  feed(chunk: Uint8Array): void {
    this.parser.feed(this.decoder.decode(chunk, { stream: true }));
  }

  get terminal(): boolean {
    return this.done !== undefined || this.error !== undefined;
  }

  private accept(name: string | undefined, data: string): void {
    let event: SseEvent;
    try {
      event = parseSseEvent(name ?? 'message', data);
    } catch {
      this.invalidEvents += 1;
      return;
    }
    switch (event.event) {
      case 'token':
        this.text += event.data.d;
        break;
      case 'sources':
        this.sources = event.data;
        break;
      case 'done':
        this.done = event.data;
        break;
      case 'error':
        this.error = event.data;
        break;
      default:
        break;
    }
  }
}

/** How a finished stream is stored on the assistant message. */
export const MESSAGE_STATUS: Record<DoneStatus, 'complete' | 'no_answer' | 'cached' | 'degraded'> =
  {
    answered: 'complete',
    no_answer_gate: 'no_answer',
    no_answer_model: 'no_answer',
    cached: 'cached',
    degraded: 'degraded',
  };
