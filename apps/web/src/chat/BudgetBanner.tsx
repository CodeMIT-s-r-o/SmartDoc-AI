import { Alert } from '@mui/material';
import { useEffect, useState } from 'react';
import type { BudgetBlock } from './api';

/** "in 2 h 14 min" until the budget resets. */
export function untilReset(resetsAt: string, now: number = Date.now()): string {
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (minutes <= 1) {
    return 'in a minute';
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `in ${hours} h ${rest} min` : `in ${minutes} min`;
}

/** The current time, refreshed while mounted (render itself must stay pure). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function BudgetBanner({
  budget,
  now: fixedNow,
}: {
  budget: BudgetBlock | null;
  now?: number;
}) {
  const ticking = useNow(30_000);
  const now = fixedNow ?? ticking;
  if (!budget || Date.parse(budget.resetsAt) <= now) {
    return null;
  }
  const at = new Date(budget.resetsAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Alert severity="warning" variant="outlined" sx={{ mx: 1.5, mt: 1.5 }}>
      {budget.scope === 'user'
        ? "You have used today's AI budget."
        : "SmartDoc's shared daily AI budget is used up."}{' '}
      New questions work again at {at} ({untilReset(budget.resetsAt, now)}).
    </Alert>
  );
}
