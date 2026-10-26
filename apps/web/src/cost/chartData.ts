import type { SpendRow } from './api';

/** Ledger purposes in a fixed order: a purpose keeps its color whichever ones a range contains. */
export const PURPOSES = ['chat', 'rewrite', 'query_embed', 'doc_embed', 'judge', 'eval'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const PURPOSE_LABELS: Record<Purpose, string> = {
  chat: 'Chat answers',
  rewrite: 'Follow-up rewrite',
  query_embed: 'Question embeddings',
  doc_embed: 'Document ingest',
  judge: 'Judge',
  eval: 'Evals',
};

export type DayRow = { day: string } & Partial<Record<Purpose, number>>;

/** One row per day of the range (days without spend included, so the time axis is honest). */
export function spendRows(rows: SpendRow[], from: string, to: string): DayRow[] {
  const byDay = new Map<string, DayRow>();
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    byDay.set(day, { day });
  }
  for (const row of rows) {
    const entry = byDay.get(row.day) ?? { day: row.day };
    if ((PURPOSES as readonly string[]).includes(row.purpose)) {
      entry[row.purpose as Purpose] = (entry[row.purpose as Purpose] ?? 0) + row.costUsd;
    }
    byDay.set(row.day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Purposes that appear in the range, in the fixed order. */
export const presentPurposes = (rows: SpendRow[]): Purpose[] =>
  PURPOSES.filter((p) => rows.some((r) => r.purpose === p));

export interface WaterfallStep {
  label: string;
  kind: 'total' | 'step';
  usdPer1k: number;
}

export interface WaterfallBar extends WaterfallStep {
  /** Invisible part of the stacked bar that lifts a step to where the running total is. */
  base: number;
  size: number;
  effect: 'total' | 'saving' | 'cost';
}

export function waterfallBars(steps: WaterfallStep[]): WaterfallBar[] {
  let running = 0;
  return steps.map((step) => {
    if (step.kind === 'total') {
      running = step.usdPer1k;
      return { ...step, base: 0, size: step.usdPer1k, effect: 'total' };
    }
    const before = running;
    running += step.usdPer1k;
    return {
      ...step,
      base: Math.min(before, running),
      size: Math.abs(step.usdPer1k),
      effect: step.usdPer1k < 0 ? 'saving' : 'cost',
    };
  });
}
