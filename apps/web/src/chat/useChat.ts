import type { FeedbackRequest } from '@smartdoc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import {
  clearRating,
  type ConversationDetail,
  createConversation,
  getConversation,
  rateAnswer,
  sendErrorMessage,
  streamMessage,
} from './api';
import { applyEvent, chatItems, type LiveTurn } from './view';

const STORAGE_KEY = 'smartdoc.conversationId';

const readStored = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeStored = (id: string | null) => {
  try {
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Private mode or blocked storage: the chat still works, it just is not remembered.
  }
};

export const conversationKey = (id: string | null) => ['conversation', id] as const;

export function useChat(token: string) {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(readStored);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const abort = useRef<AbortController | null>(null);

  const conversation = useQuery({
    queryKey: conversationKey(conversationId),
    queryFn: () => getConversation(token, conversationId!),
    enabled: conversationId !== null,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });

  const select = useCallback((id: string | null) => {
    abort.current?.abort();
    setLive(null);
    setConversationId(id);
    writeStored(id);
  }, []);

  // A remembered conversation that is gone (deleted, or another user signed in): start fresh.
  const missing = conversation.error instanceof ApiError && conversation.error.status === 404;
  useEffect(() => {
    if (missing) {
      select(null);
    }
  }, [missing, select]);

  const send = useCallback(
    async (question: string, clientMessageId: string = crypto.randomUUID()) => {
      if (abort.current) {
        return; // one question at a time
      }
      const controller = new AbortController();
      abort.current = controller;
      const update = (change: (turn: LiveTurn) => LiveTurn | null) =>
        setLive((turn) => (turn?.clientMessageId === clientMessageId ? change(turn) : turn));
      setLive({ clientMessageId, question, text: '', sources: [], stopped: false, running: true });

      let id = conversationId;
      let replayed = false;
      try {
        if (!id) {
          const created = await createConversation(token);
          id = created.id;
          queryClient.setQueryData<ConversationDetail>(conversationKey(id), {
            conversation: created,
            messages: [],
          });
          setConversationId(id);
          writeStored(id);
        }
        const result = await streamMessage(
          token,
          id,
          { clientMessageId, content: question },
          controller.signal,
          (event) => update((turn) => applyEvent(turn, event)),
        );
        replayed = result.kind === 'replay';
      } catch (error) {
        update((turn) =>
          controller.signal.aborted
            ? { ...turn, stopped: true }
            : { ...turn, error: sendErrorMessage(error) },
        );
      } finally {
        abort.current = null;
        update((turn) => ({ ...turn, running: false }));
        if (id) {
          const refresh = () => queryClient.invalidateQueries({ queryKey: conversationKey(id) });
          await refresh();
          if (replayed) {
            update(() => null); // the stored turn is now in the list
          }
          if (controller.signal.aborted) {
            // The API stores the aborted answer right after the connection closes.
            setTimeout(() => void refresh(), 1000);
          }
        }
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      }
    },
    [conversationId, queryClient, token],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  const rate = useMutation({
    mutationFn: ({
      messageId,
      feedback,
    }: {
      messageId: string;
      feedback: FeedbackRequest | null;
    }) => (feedback ? rateAnswer(token, messageId, feedback) : clearRating(token, messageId)),
    onMutate: async ({ messageId, feedback }) => {
      const key = conversationKey(conversationId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ConversationDetail>(key);
      queryClient.setQueryData<ConversationDetail>(
        key,
        (detail) =>
          detail && {
            ...detail,
            messages: detail.messages.map((m) =>
              m.id === messageId ? { ...m, rating: feedback?.rating ?? null } : m,
            ),
          },
      );
      return { previous, key };
    },
    onError: (_, __, context) => {
      if (context) {
        queryClient.setQueryData(context.key, context.previous);
      }
    },
  });

  return {
    conversationId,
    conversation,
    items: chatItems(conversation.data?.messages ?? [], live),
    live,
    running: live?.running ?? false,
    select,
    send,
    stop,
    /** Retries the last failed question; reuses its key if the API never acknowledged it. */
    retry: (question: string) => {
      const sameKey = live && !live.ack && live.question === question;
      void send(question, sameKey ? live.clientMessageId : undefined);
    },
    rate,
  };
}
