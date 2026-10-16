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

/** The presigned POST expires after 5 minutes; a reservation older than this will never finish. */
const UPLOAD_ABANDONED_AFTER_MS = 10 * 60 * 1000;

export const isInterruptedUpload = (doc: DocumentDto, now: number = Date.now()): boolean =>
  doc.status === 'uploading' && now - Date.parse(doc.createdAt) > UPLOAD_ABANDONED_AFTER_MS;

export const listDocuments = (token: string) => api<DocumentDto[]>('GET', '/documents', token);

export const deleteDocument = (token: string, id: string) =>
  api<void>('DELETE', `/documents/${id}`, token);

/** XHR rather than fetch: only XHR reports upload progress. */
function postForm(
  url: string,
  form: FormData,
  onProgress: (fraction: number) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Network error during upload'));
    xhr.send(form);
  });
}

/** Hex SHA-256 of the file's bytes (WebCrypto); up to 20 MB takes well under a second. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Three steps: reserve the document, POST the file straight to S3 with the presigned policy,
 * then ask the API to validate what landed and queue ingestion. The file's SHA-256 lets the API
 * refuse a second copy (409 DUPLICATE_DOCUMENT) and lets S3 reject bytes that do not match.
 */
export async function uploadDocument(
  token: string,
  file: File,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<DocumentDto> {
  const { document, upload } = await api<CreateDocumentResponse>('POST', '/documents', token, {
    filename: file.name,
    sizeBytes: file.size,
    sha256: await sha256Hex(file),
  });

  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) {
    form.append(name, value);
  }
  form.append('file', file); // S3 requires the file to be the last field
  const s3 = await postForm(upload.url, form, onProgress);
  if (s3.status >= 300) {
    // S3 answers policy violations with XML; the interesting part is the <Code>.
    const code = /<Code>([^<]+)<\/Code>/.exec(s3.body)?.[1] ?? `HTTP_${s3.status}`;
    const mapped: Record<string, string> = {
      EntityTooLarge: 'FILE_TOO_LARGE',
      BadDigest: 'UPLOAD_CORRUPTED',
      XAmzContentChecksumMismatch: 'UPLOAD_CORRUPTED',
    };
    throw new ApiError(
      s3.status,
      mapped[code] ?? 'UPLOAD_REJECTED',
      `S3 rejected the upload (${code})`,
    );
  }

  return api<DocumentDto>('POST', `/documents/${document.id}/complete`, token);
}

export async function openDocument(token: string, id: string, page?: number): Promise<void> {
  // Open the tab synchronously (popup blockers), then point it at the short-lived URL.
  const tab = window.open('', '_blank');
  try {
    const { url } = await api<{ url: string }>('GET', `/documents/${id}/file`, token);
    const target = page ? `${url}#page=${page}` : url;
    if (tab) {
      tab.opener = null;
      tab.location.href = target;
    } else {
      window.open(target, '_blank', 'noopener');
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}

const UPLOAD_MESSAGES: Record<string, string> = {
  FILE_TOO_LARGE: 'PDFs are limited to 20 MB.',
  INVALID_FILE: 'That file is not a valid PDF.',
  VALIDATION_FAILED: 'Only .pdf files can be uploaded.',
  QUOTA_EXCEEDED: 'You have reached the limit of 50 documents.',
  RATE_LIMITED: 'Too many uploads. Try again later.',
  UPLOAD_REJECTED: 'The upload was rejected. Try again.',
  UPLOAD_CORRUPTED: 'The file changed or was damaged on the way. Try again.',
  DUPLICATE_DOCUMENT: 'This file is already in your documents.',
  UNAVAILABLE: 'The service is temporarily unavailable. Try again in a minute.',
};

/** Not a failure: the file is already there, so the upload has nothing to do. */
export const isDuplicateUpload = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'DUPLICATE_DOCUMENT';

export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return UPLOAD_MESSAGES[error.code] ?? error.message;
  }
  return 'Upload failed. Check your connection and try again.';
}

/** Why ingestion failed, in words (documents.error_code from the API and the worker). */
const FAILURE_MESSAGES: Record<string, string> = {
  INVALID_FILE: 'Not a valid PDF file.',
  INVALID_PDF: 'The PDF could not be read.',
  NO_TEXT_LAYER: 'No selectable text. Scanned PDFs are not supported yet.',
  ENCRYPTED: 'The PDF is password-protected.',
  TOO_MANY_PAGES: 'More than 300 pages.',
  PARSE_LIMIT_EXCEEDED: 'Too large or complex to process safely.',
  DOCUMENT_UNAVAILABLE: 'The file was no longer available.',
  ATTEMPTS_EXHAUSTED: 'Processing kept failing. Delete it and upload it again.',
  INGESTION_FAILED: 'Processing failed. Delete it and upload it again.',
};

export const failureMessage = (code: string | null): string =>
  (code && FAILURE_MESSAGES[code]) ?? 'Processing failed.';
