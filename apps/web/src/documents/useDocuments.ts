import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { type DocumentDto, listDocuments } from './api';

/** Poll while ingestion is in flight: 2 s, then 5 s, then every 10 s; stop when all are settled. */
export const POLL_BACKOFF_MS = [2000, 5000, 10000] as const;

const isPending = (doc: DocumentDto) => doc.status === 'queued' || doc.status === 'processing';

export function nextPollInterval(
  docs: DocumentDto[] | undefined,
  pollsSoFar: number,
): number | false {
  if (!docs?.some(isPending)) {
    return false;
  }
  return POLL_BACKOFF_MS[Math.min(pollsSoFar, POLL_BACKOFF_MS.length - 1)]!;
}

export function useDocuments(token: string) {
  // dataUpdateCount when the current pending phase began. Derived from query state, because
  // refetchInterval is evaluated on every update and render, not once per poll.
  const pendingSince = useRef<number | null>(null);
  return useQuery({
    queryKey: ['documents'],
    queryFn: () => listDocuments(token),
    refetchInterval: (query) => {
      const { data, dataUpdateCount } = query.state;
      if (!data?.some(isPending)) {
        pendingSince.current = null;
        return false;
      }
      pendingSince.current ??= dataUpdateCount;
      return nextPollInterval(data, dataUpdateCount - pendingSince.current);
    },
  });
}
