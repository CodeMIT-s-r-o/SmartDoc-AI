import { ThemeProvider } from '@mui/material';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { theme } from '../theme';
import type { Citation } from './api';
import { AssistantMessage } from './AssistantMessage';
import type { AnswerView } from './view';

const citation = (n: number, cited: boolean): Citation => ({
  n,
  chunkId: `00000000-0000-4000-8000-00000000000${n}`,
  documentId: '00000000-0000-4000-8000-000000000009',
  title: n === 1 ? 'Travel Policy' : 'Handbook',
  section: '3 Per diem',
  pageStart: 7,
  pageEnd: 8,
  score: 0.7,
  snippet: 'The daily meal allowance within the EU is EUR 45.',
  cited,
});

const answer = (overrides: Partial<AnswerView>): AnswerView => ({
  messageId: 'm1',
  text: 'The allowance is EUR 45 [1].',
  status: 'complete',
  phase: null,
  citations: [citation(1, true), citation(2, false)],
  costUsd: 0.00038,
  latencyMs: { ttft: 1200, total: 4800 },
  usage: null,
  rating: null,
  error: null,
  ...overrides,
});

const renderAnswer = (view: AnswerView, canRetry = false) => {
  const handlers = { onRetry: vi.fn(), onOpenSource: vi.fn(), onRate: vi.fn() };
  render(
    <ThemeProvider theme={theme}>
      <AssistantMessage answer={view} canRetry={canRetry} {...handlers} />
    </ThemeProvider>,
  );
  return handlers;
};

describe('AssistantMessage', () => {
  afterEach(cleanup);

  it('shows the answer with its cost, and opens the cited page of the PDF', async () => {
    const { onOpenSource } = renderAnswer(answer({}));

    expect(screen.getByText('$0.00038 · 4.8 s')).toBeTruthy();
    expect(screen.getByText('+1 more passages')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Source 1: Travel Policy, pp. 7–8' }));
    expect(screen.getByText('The daily meal allowance within the EU is EUR 45.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open PDF p. 7' }));

    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ n: 1, pageStart: 7 }));
  });

  it('saves a thumbs-down at once, then asks why', async () => {
    const { onRate } = renderAnswer(answer({}));

    await userEvent.click(screen.getByRole('button', { name: 'Bad answer' }));
    expect(onRate).toHaveBeenLastCalledWith('m1', { rating: -1 });
    await userEvent.click(screen.getByText('Wrong citation'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onRate).toHaveBeenLastCalledWith('m1', {
      rating: -1,
      reasons: ['wrong_citation'],
      comment: undefined,
    });
  });

  it('removes a rating when the active thumb is clicked again', async () => {
    const { onRate } = renderAnswer(answer({ rating: 1 }));

    await userEvent.click(screen.getByRole('button', { name: 'Good answer' }));

    expect(onRate).toHaveBeenCalledWith('m1', null);
  });

  it('shows the closest passages when the AI answer is unavailable', () => {
    renderAnswer(answer({ status: 'degraded', text: 'Unavailable.', costUsd: 0 }));

    expect(screen.getByText(/The AI answer is temporarily unavailable/)).toBeTruthy();
    expect(screen.getByText('Closest passages')).toBeTruthy();
    expect(screen.getAllByText(/Travel Policy|Handbook/)).toHaveLength(2);
  });

  it('offers a retry on a failed answer and hides the thumbs', async () => {
    const { onRetry } = renderAnswer(
      answer({ status: 'error', text: '', error: 'The answer was interrupted.' }),
      true,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Bad answer' })).toBeNull();
  });

  it('shows progress, not a footer, while searching', () => {
    renderAnswer(answer({ status: 'streaming', phase: 'searching', text: '', citations: [] }));

    expect(screen.getByText('Searching your documents…')).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });
});
