import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useRef, useState } from 'react';
import {
  type DocumentDto,
  MAX_UPLOAD_BYTES,
  openDocument,
  uploadDocument,
  uploadErrorMessage,
} from './api';
import { useDocuments } from './useDocuments';

const STATUS_LABELS: Record<DocumentDto['status'], string> = {
  uploading: 'Uploading',
  queued: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
  deleting: 'Deleting',
};

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DocumentsPanel({ accessToken }: { accessToken: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const documents = useDocuments(accessToken);

  const upload = useMutation({
    mutationFn: (file: File) => uploadDocument(accessToken, file),
    onMutate: () => setError(undefined),
    onError: (e) => setError(uploadErrorMessage(e)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['documents'] }),
  });

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('PDFs are limited to 20 MB.');
      return;
    }
    upload.mutate(file);
  };

  return (
    <section>
      <h2>Documents</h2>
      <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={onFile} />
      <button disabled={upload.isPending} onClick={() => input.current?.click()}>
        {upload.isPending ? 'Uploading…' : 'Upload PDF'}
      </button>
      {error && <p role="alert">{error}</p>}

      {documents.isPending && <p>Loading documents…</p>}
      {documents.isError && <p role="alert">Could not load documents.</p>}
      {documents.data?.length === 0 && <p>No documents yet. Upload a PDF to get started.</p>}
      {documents.data && documents.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th align="left">Title</th>
              <th align="left">Status</th>
              <th align="right">Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {documents.data.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.title}</td>
                <td title={doc.errorCode ?? undefined}>{STATUS_LABELS[doc.status]}</td>
                <td align="right">{formatSize(doc.sizeBytes)}</td>
                <td>
                  {doc.status === 'ready' && (
                    <button onClick={() => void openDocument(accessToken, doc.id)}>Open</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
