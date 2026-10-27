import { describe, expect, it } from 'vitest';
import { lastDays } from './api';
import { presentPurposes, spendRows, waterfallBars } from './chartData';

describe('spendRows', () => {
  const rows = [
    { day: '2026-10-24', purpose: 'chat', costUsd: 0.002, calls: 4 },
    { day: '2026-10-24', purpose: 'query_embed', costUsd: 0.00001, calls: 4 },
    { day: '2026-10-26', purpose: 'chat', costUsd: 0.001, calls: 2 },
  ];

  it('has a row for every day of the range, empty days included', () => {
    expect(spendRows(rows, '2026-10-23', '2026-10-26')).toEqual([
      { day: '2026-10-23' },
      { day: '2026-10-24', chat: 0.002, query_embed: 0.00001 },
      { day: '2026-10-25' },
      { day: '2026-10-26', chat: 0.001 },
    ]);
  });

  it('keeps purposes in the fixed order, not the order they appear', () => {
    expect(presentPurposes([...rows].reverse())).toEqual(['chat', 'query_embed']);
  });
});

describe('waterfallBars', () => {
  it('floats each step at the running total and keeps totals on the axis', () => {
    const bars = waterfallBars([
      { label: 'Naive', kind: 'total', usdPer1k: 0.56 },
      { label: 'No reasoning', kind: 'step', usdPer1k: -0.2 },
      { label: 'Rest', kind: 'step', usdPer1k: 0.01 },
      { label: 'Optimized', kind: 'total', usdPer1k: 0.37 },
    ]);

    expect(bars.map(({ base, size, effect }) => ({ base, size, effect }))).toEqual([
      { base: 0, size: 0.56, effect: 'total' },
      { base: expect.closeTo(0.36), size: 0.2, effect: 'saving' },
      { base: expect.closeTo(0.36), size: 0.01, effect: 'cost' },
      { base: 0, size: 0.37, effect: 'total' },
    ]);
  });
});

describe('lastDays', () => {
  it('is an inclusive range ending today', () => {
    expect(lastDays(7, new Date('2026-10-26T20:00:00Z'))).toEqual({
      from: '2026-10-20',
      to: '2026-10-26',
    });
  });
});
