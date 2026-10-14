import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetBanner, untilReset } from './BudgetBanner';

const now = Date.parse('2026-10-05T19:46:00Z');
const resetsAt = '2026-10-05T22:00:00Z'; // midnight in Bratislava (CEST)

describe('BudgetBanner', () => {
  afterEach(cleanup);

  it('counts down to the reset', () => {
    expect(untilReset(resetsAt, now)).toBe('in 2 h 14 min');
    expect(untilReset(resetsAt, Date.parse('2026-10-05T21:35:00Z'))).toBe('in 25 min');
    expect(untilReset(resetsAt, Date.parse('2026-10-05T21:59:30Z'))).toBe('in a minute');
  });

  it('tells the user their budget is used up, and the shared one apart from it', () => {
    const { rerender } = render(<BudgetBanner budget={{ scope: 'user', resetsAt }} now={now} />);
    expect(screen.getByText(/You have used today's AI budget\..*\(in 2 h 14 min\)/)).toBeTruthy();

    rerender(<BudgetBanner budget={{ scope: 'app', resetsAt }} now={now} />);
    expect(screen.getByText(/shared daily AI budget is used up/)).toBeTruthy();
  });

  it('disappears once the budget has reset', () => {
    const { container } = render(
      <BudgetBanner budget={{ scope: 'user', resetsAt }} now={Date.parse(resetsAt) + 1} />,
    );
    expect(container.textContent).toBe('');
  });
});
