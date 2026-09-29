import type { SseEvent } from '@smartdoc/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { sendErrorMessage, streamMessage } from './api';

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A response body that arrives in arbitrary pieces, like a real network stream. */
const chunked = (text: string, size: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    },
  });

const send = (onEvent: (e: SseEvent) => void = () => undefined) =>
  streamMessage(
    'token',
    'conv-1',
    { clientMessageId: 'c1', content: 'Q?' },
    new AbortController().signal,
    onEvent,
  );

describe('streamMessage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('delivers validated events in order, whatever the chunking, and skips invalid ones', async () => {
    const body =
      frame('token', { d: 'Dovolenka: 25 dní ' }) +
      frame('token', { text: 'breaks the contract' }) +
      ': ping\n\n' +
      frame('token', { d: '[1].' });
    const fetchMock = vi.fn(
      () => new Response(chunked(body, 7), { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const events: SseEvent[] = [];

    await expect(send((e) => events.push(e))).resolves.toEqual({ kind: 'stream' });

    expect(events).toEqual([
      { event: 'token', data: { d: 'Dovolenka: 25 dní ' } },
      { event: 'token', data: { d: '[1].' } },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conv-1/messages',
      expect.objectContaining({ method: 'POST', body: '{"clientMessageId":"c1","content":"Q?"}' }),
    );
  });

  it('returns the stored answer when the API replays a repeated clientMessageId', async () => {
    const assistantMessage = { id: 'm1', status: 'complete', content: 'Stored' };
    vi.stubGlobal('fetch', () => Response.json({ userMessage: {}, assistantMessage }));

    await expect(send()).resolves.toEqual({ kind: 'replay', assistantMessage });
  });

  it('turns a problem+json refusal into an ApiError with a readable message', async () => {
    vi.stubGlobal('fetch', () =>
      Response.json(
        { status: 409, code: 'NO_DOCUMENTS', detail: 'Upload a document first' },
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    );

    const error = await send().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NO_DOCUMENTS');
    expect(sendErrorMessage(error)).toBe(
      'Upload a document and wait until it is ready before asking.',
    );
    expect(sendErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Connection lost/);
  });
});
