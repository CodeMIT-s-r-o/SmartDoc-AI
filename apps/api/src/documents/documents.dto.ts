import { z } from 'zod';
import type { SignedUrl, UploadPost } from '../storage/document-storage.js';
import type { DocumentRow } from './documents.repository.js';

export const createDocumentSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/\.pdf$/i, 'Only PDF files are supported'),
  sizeBytes: z.number().int().positive(),
});
export type CreateDocumentBody = z.infer<typeof createDocumentSchema>;

export interface DocumentDto {
  id: string;
  title: string;
  originalFilename: string;
  status: DocumentRow['status'];
  sizeBytes: number;
  pageCount: number | null;
  chunkCount: number | null;
  errorCode: string | null;
  embedCostUsd: number | null;
  createdAt: string;
  readyAt: string | null;
}

export interface CreateDocumentResponse {
  document: DocumentDto;
  upload: UploadPost;
}

export type FileUrlResponse = SignedUrl;

export function toDocumentDto(row: DocumentRow): DocumentDto {
  return {
    id: row.id,
    title: row.title,
    originalFilename: row.originalFilename,
    status: row.status,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    errorCode: row.errorCode,
    embedCostUsd: row.embedCostUsd === null ? null : Number(row.embedCostUsd),
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
  };
}
