import { ThemeProvider } from '@mui/material';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { theme } from '../theme';
import type { DocumentDto } from './api';
import { DocumentList } from './DocumentList';

const doc = (overrides: Partial<DocumentDto>): DocumentDto => ({
  id: crypto.randomUUID(),
  title: 'Handbook',
  originalFilename: 'Handbook.pdf',
  status: 'ready',
  sizeBytes: 160_960,
  pageCount: 102,
  chunkCount: 214,
  errorCode: null,
  embedCostUsd: 0.0015,
  createdAt: '2026-09-28T20:00:00Z',
  readyAt: '2026-09-28T20:00:06Z',
  ...overrides,
});

const renderList = (documents: DocumentDto[]) => {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  render(
    <ThemeProvider theme={theme}>
      <DocumentList documents={documents} onOpen={onOpen} onDelete={onDelete} />
    </ThemeProvider>,
  );
  return { onOpen, onDelete };
};

describe('DocumentList', () => {
  // Vitest runs without globals here, so Testing Library cannot register its own cleanup.
  afterEach(cleanup);

  it('shows pages, size and status for a ready document, and opens it', async () => {
    const ready = doc({ title: 'Employee Handbook' });
    const { onOpen } = renderList([ready]);

    expect(screen.getByText('Employee Handbook')).toBeTruthy();
    expect(screen.getByText(/102 pages · 157 KB/)).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Open Employee Handbook' }));
    expect(onOpen).toHaveBeenCalledWith(ready);
  });

  it('explains why a document failed and offers no Open action', () => {
    renderList([
      doc({ title: 'Scan', status: 'failed', errorCode: 'NO_TEXT_LAYER', pageCount: null }),
    ]);

    expect(
      screen.getByText('No selectable text. Scanned PDFs are not supported yet.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Scan' })).toBeNull();
  });

  it('offers Delete in every state, including uploading and processing', async () => {
    const docs = (['uploading', 'queued', 'processing', 'ready', 'failed'] as const).map((status) =>
      doc({ title: `Doc ${status}`, status }),
    );
    const { onDelete } = renderList(docs);

    for (const d of docs) {
      await userEvent.click(screen.getByRole('button', { name: `Delete ${d.title}` }));
    }
    expect(onDelete.mock.calls.map(([d]) => (d as DocumentDto).status)).toEqual([
      'uploading',
      'queued',
      'processing',
      'ready',
      'failed',
    ]);
  });

  it('marks a reservation whose upload never finished as interrupted', () => {
    renderList([
      doc({
        title: 'Old',
        status: 'uploading',
        createdAt: '2026-01-01T00:00:00Z',
        pageCount: null,
      }),
    ]);

    expect(screen.getByText('Interrupted')).toBeTruthy();
    expect(
      screen.getByText('Upload interrupted. Delete it and upload the file again.'),
    ).toBeTruthy();
  });
});
