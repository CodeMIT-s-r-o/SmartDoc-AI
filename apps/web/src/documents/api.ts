import { api, ApiError } from '../api';

export type DocumentStatus =
  'uploading' | 'queued' | 'processing' | 'ready' | 'failed' | 'deleting';

export interface DocumentDto {
  id: string;
  title: string;
  originalFilename: string;
  status: DocumentStatus;
  sizeBytes: number;
  pageCount: number | null;
  chunkCount: number | null;
  errorCode: string | null;
  embedCostUsd: number | null;
  createdAt: string;
  readyAt: string | null;
}

interface CreateDocumentResponse {
  document: DocumentDto;
  upload: { url: string; fields: Record<string, string>; expiresAt: string };
}

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const listDocuments = (token: string) => api<DocumentDto[]>('GET', '/documents', token);

/** S3 answers policy violations with XML; the interesting part is the <Code>. */
async function s3ErrorCode(res: Response): Promise<string> {
  const xml = await res.text().catch(() => '');
  return /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ?? `HTTP_${res.status}`;
}

/**
 * Three steps: reserve the document, POST the file straight to S3 with the presigned policy,
 * then ask the API to validate what landed and queue ingestion.
 */
export async function uploadDocument(token: string, file: File): Promise<DocumentDto> {
  const { document, upload } = await api<CreateDocumentResponse>('POST', '/documents', token, {
    filename: file.name,
    sizeBytes: file.size,
  });

  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) {
    form.append(name, value);
  }
  form.append('file', file); // S3 requires the file to be the last field
  const s3 = await fetch(upload.url, { method: 'POST', body: form });
  if (!s3.ok) {
    const code = await s3ErrorCode(s3);
    throw new ApiError(
      s3.status,
      code === 'EntityTooLarge' ? 'FILE_TOO_LARGE' : 'UPLOAD_REJECTED',
      `S3 rejected the upload (${code})`,
    );
  }

  return api<DocumentDto>('POST', `/documents/${document.id}/complete`, token);
}

export async function openDocument(token: string, id: string, page?: number): Promise<void> {
  const { url } = await api<{ url: string }>('GET', `/documents/${id}/file`, token);
  window.open(page ? `${url}#page=${page}` : url, '_blank', 'noopener');
}

const MESSAGES: Record<string, string> = {
  FILE_TOO_LARGE: 'PDFs are limited to 20 MB.',
  INVALID_FILE: 'That file is not a valid PDF.',
  VALIDATION_FAILED: 'Only .pdf files can be uploaded.',
  QUOTA_EXCEEDED: 'You have reached the limit of 50 documents.',
  RATE_LIMITED: 'Too many uploads. Try again later.',
  UPLOAD_REJECTED: 'The upload was rejected. Try again.',
};

export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGES[error.code] ?? error.message;
  }
  return 'Upload failed. Check your connection and try again.';
}
