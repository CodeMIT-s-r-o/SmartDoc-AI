import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context.js';
import { ProblemException } from '../common/problem.js';
import {
  DocumentStorage,
  documentKey,
  MAX_UPLOAD_BYTES,
  PDF_CONTENT_TYPE,
  type SignedUrl,
} from '../storage/document-storage.js';
import {
  type CreateDocumentBody,
  type CreateDocumentResponse,
  type DocumentDto,
  toDocumentDto,
} from './documents.dto.js';
import { type DocumentRow, DocumentsRepository } from './documents.repository.js';

export const DOCUMENT_QUOTA = 50;
const PDF_MAGIC = '%PDF-';

const notFound = () =>
  new ProblemException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Document not found');

const titleFromFilename = (filename: string): string =>
  filename
    .replace(/\.pdf$/i, '')
    .trim()
    .slice(0, 200) || 'Untitled document';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly storage: DocumentStorage,
  ) {}

  async create(auth: AuthContext, body: CreateDocumentBody): Promise<CreateDocumentResponse> {
    if (body.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'FILE_TOO_LARGE',
        `PDFs are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
      );
    }
    if ((await this.repo.countActive(auth.tenantId)) >= DOCUMENT_QUOTA) {
      throw new ProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'QUOTA_EXCEEDED',
        `You can keep at most ${DOCUMENT_QUOTA} documents`,
      );
    }

    const id = randomUUID();
    const s3Key = documentKey(auth.tenantId, id);
    const row = await this.repo.insertUploading({
      id,
      tenantId: auth.tenantId,
      title: titleFromFilename(body.filename),
      originalFilename: body.filename,
      s3Key,
      sizeBytes: body.sizeBytes,
    });
    return { document: toDocumentDto(row), upload: await this.storage.createUploadPost(s3Key) };
  }

  /**
   * Validates what actually landed in S3 (size, type, `%PDF-` magic bytes on that exact version),
   * then queues ingestion for that version only, so a later re-POST to the key is never processed.
   */
  async complete(auth: AuthContext, id: string): Promise<DocumentDto> {
    const doc = await this.repo.findOwned(auth.tenantId, id);
    if (!doc) {
      throw notFound();
    }
    if (doc.status !== 'uploading') {
      throw new ProblemException(HttpStatus.CONFLICT, 'INVALID_STATE', `Document is ${doc.status}`);
    }

    const head = await this.storage.head(doc.s3Key);
    if (!head?.versionId) {
      throw new ProblemException(HttpStatus.CONFLICT, 'UPLOAD_NOT_FOUND', 'Upload the file first');
    }

    const problem = await this.validateUpload(doc, head.versionId, head);
    if (problem) {
      await this.storage.deleteVersion(doc.s3Key, head.versionId);
      await this.repo.markUploadFailed(auth.tenantId, id, 'INVALID_FILE', problem);
      throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_FILE', problem);
    }

    const queued = await this.repo.queueForIngestion(
      auth.tenantId,
      id,
      head.versionId,
      head.sizeBytes,
    );
    if (!queued) {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'INVALID_STATE',
        'Document was already completed',
      );
    }
    return toDocumentDto(queued);
  }

  async list(auth: AuthContext): Promise<DocumentDto[]> {
    return (await this.repo.listOwned(auth.tenantId)).map(toDocumentDto);
  }

  async get(auth: AuthContext, id: string): Promise<DocumentDto> {
    const doc = await this.repo.findOwned(auth.tenantId, id);
    if (!doc) {
      throw notFound();
    }
    return toDocumentDto(doc);
  }

  /** A 5-minute inline URL for viewing a ready PDF (the SPA appends #page=N). */
  async fileUrl(auth: AuthContext, id: string): Promise<SignedUrl> {
    const doc = await this.repo.findOwned(auth.tenantId, id);
    if (!doc) {
      throw notFound();
    }
    if (doc.status !== 'ready' || !doc.s3VersionId) {
      throw new ProblemException(HttpStatus.CONFLICT, 'INVALID_STATE', `Document is ${doc.status}`);
    }
    return this.storage.presignGet(doc.s3Key, doc.s3VersionId, `${doc.title}.pdf`);
  }

  /** For the ingestion worker, which has no AWS credentials of its own. */
  async ingestionDownloadUrl(id: string): Promise<SignedUrl> {
    const doc = await this.repo.findForIngestion(id);
    if (!doc?.s3VersionId) {
      throw notFound();
    }
    return this.storage.presignGet(doc.s3Key, doc.s3VersionId);
  }

  private async validateUpload(
    doc: DocumentRow,
    versionId: string,
    head: { sizeBytes: number; contentType: string | undefined },
  ): Promise<string | undefined> {
    if (head.sizeBytes < PDF_MAGIC.length || head.sizeBytes > MAX_UPLOAD_BYTES) {
      return 'The file is empty or too large';
    }
    if (head.contentType !== PDF_CONTENT_TYPE) {
      return 'The file is not a PDF';
    }
    const prefix = await this.storage.readPrefix(doc.s3Key, versionId, PDF_MAGIC.length);
    if (Buffer.from(prefix).toString('latin1') !== PDF_MAGIC) {
      return 'The file is not a PDF';
    }
    return undefined;
  }
}
