import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from './useChat';

const conversation = {
  id: '00000000-0000-4000-8000-0000000000c1',
  title: null,
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z',
};
const ack = {
  requestId: '00000000-0000-4000-8000-000000000001',
  conversationId: conversation.id,
  userMessageId: '00000000-0000-4000-8000-000000000002',
  assistantMessageId: '00000000-0000-4000-8000-000000000003',
};
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Sends ack and one token, then hangs until the request is aborted (like a slow answer). */
const hangingStream = (signal: AbortSignal) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(frame('ack', ack) + frame('token', { d: 'Par' })),
      );
      signal.addEventListener('abort', () =>
        controller.error(new DOMException('The operation was aborted.', 'AbortError')),
      );
    },
  });

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

describe('useChat', () => {
  let sends: { clientMessageId: string }[];

  beforeEach(() => {
    localStorage.clear();
    sends = [];
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const stubApi = (onSend: (signal: AbortSignal) => Response) =>
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/api/conversations' && init.method === 'POST') {
          return Promise.resolve(Response.json(conversation));
        }
        if (url.endsWith('/messages')) {
          sends.push(JSON.parse(init.body as string) as { clientMessageId: string });
          return Promise.resolve(onSend(init.signal!));
        }
        if (url === `/api/conversations/${conversation.id}`) {
          return Promise.resolve(Response.json({ conversation, messages: [] }));
        }
        return Promise.resolve(Response.json([]));
      }),
    );

  it('creates the conversation on the first question, and Stop keeps the partial answer', async () => {
    stubApi(
      (signal) =>
        new Response(hangingStream(signal), { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const { result } = renderHook(() => useChat('token'), { wrapper });

    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('How much leave?');
    });
    await waitFor(() => expect(result.current.live?.text).toBe('Par'));
    expect(result.current.running).toBe(true);
    expect(localStorage.getItem('smartdoc.conversationId')).toBe(conversation.id);

    await act(async () => {
      result.current.stop();
      await sending;
    });

    expect(result.current.running).toBe(false);
    expect(result.current.items.at(-1)).toMatchObject({
      kind: 'answer',
      answer: { status: 'aborted', text: 'Par', messageId: ack.assistantMessageId },
    });
  });

  it('remembers a budget refusal for the banner, and forgets it after a successful send', async () => {
    let refuse = true;
    stubApi((signal) =>
      refuse
        ? Response.json(
            {
              status: 429,
              code: 'BUDGET_EXCEEDED',
              detail: 'Budget used up',
              scope: 'user',
              resetsAt: '2026-10-05T22:00:00.000Z',
            },
            { status: 429, headers: { 'Content-Type': 'application/problem+json' } },
          )
        : new Response(hangingStream(signal), { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const { result } = renderHook(() => useChat('token'), { wrapper });

    await act(() => result.current.send('How much leave?'));
    expect(result.current.budget).toEqual({ scope: 'user', resetsAt: '2026-10-05T22:00:00.000Z' });
    expect(result.current.items.at(-1)).toMatchObject({
      answer: { status: 'error', error: "Today's AI budget is used up." },
    });

    refuse = false;
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('And now?');
    });
    await waitFor(() => expect(result.current.live?.text).toBe('Par'));
    await act(async () => {
      result.current.stop();
      await sending;
    });
    expect(result.current.budget).toBeNull();
  });

  it('retries a send the API never acknowledged with the same clientMessageId', async () => {
    stubApi(() => Response.json({ code: 'RATE_LIMITED' }, { status: 429 }));
    const { result } = renderHook(() => useChat('token'), { wrapper });

    await act(() => result.current.send('How much leave?'));
    expect(result.current.items.at(-1)).toMatchObject({
      answer: { status: 'error', error: expect.stringMatching(/Too many questions/) },
    });
    await act(async () => {
      result.current.retry('How much leave?');
      await waitFor(() => expect(sends).toHaveLength(2));
    });

    expect(sends[1]!.clientMessageId).toBe(sends[0]!.clientMessageId);
  });
});
