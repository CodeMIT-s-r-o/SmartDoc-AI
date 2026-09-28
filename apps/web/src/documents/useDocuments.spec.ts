import { describe, expect, it } from 'vitest';
import type { DocumentDto } from './api';
import { nextPollInterval } from './useDocuments';

const doc = (status: DocumentDto['status']) => ({ status }) as DocumentDto;

describe('nextPollInterval', () => {
  it('backs off 2 s → 5 s → 10 s while something is being ingested', () => {
    const docs = [doc('ready'), doc('queued')];
    expect([0, 1, 2, 3, 10].map((n) => nextPollInterval(docs, n))).toEqual([
      2000, 5000, 10000, 10000, 10000,
    ]);
  });

  it('stops polling when nothing is queued or processing', () => {
    expect(nextPollInterval([doc('ready'), doc('failed'), doc('uploading')], 3)).toBe(false);
    expect(nextPollInterval([], 0)).toBe(false);
    expect(nextPollInterval(undefined, 0)).toBe(false);
  });
});
