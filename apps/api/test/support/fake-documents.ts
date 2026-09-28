import type {
  DocumentRow,
  DocumentsRepository,
  NewDocument,
} from '../../src/documents/documents.repository.js';
import {
  type DocumentStorage,
  type ObjectHead,
  PDF_CONTENT_TYPE,
  type SignedUrl,
  type UploadPost,
} from '../../src/storage/document-storage.js';

/** In-memory documents table with the same compare-and-set semantics as the SQL. */
export class FakeDocumentsRepository implements Pick<
  DocumentsRepository,
  keyof DocumentsRepository
> {
  readonly rows = new Map<string, DocumentRow>();
  readonly jobs: string[] = [];

  countActive(tenantId: string): Promise<number> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.status !== 'deleting')
        .length,
    );
  }

  insertUploading(doc: NewDocument): Promise<DocumentRow> {
    const now = new Date();
    const row: DocumentRow = {
      ...doc,
      s3VersionId: null,
      status: 'uploading',
      errorCode: null,
      errorMessage: null,
      pageCount: null,
      chunkCount: null,
      embedTokens: null,
      embedTokensSaved: null,
      embedCostUsd: null,
      injectionFlaggedChunks: 0,
      createdAt: now,
      updatedAt: now,
      readyAt: null,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  findOwned(tenantId: string, id: string): Promise<DocumentRow | undefined> {
    const row = this.rows.get(id);
    return Promise.resolve(row?.tenantId === tenantId ? row : undefined);
  }

  listOwned(tenantId: string): Promise<DocumentRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.status !== 'deleting'),
    );
  }

  markUploadFailed(
    tenantId: string,
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const row = this.rows.get(id);
    if (row?.tenantId === tenantId && row.status === 'uploading') {
      Object.assign(row, { status: 'failed', errorCode, errorMessage });
    }
    return Promise.resolve();
  }

  queueForIngestion(
    tenantId: string,
    id: string,
    s3VersionId: string,
    sizeBytes: number,
  ): Promise<DocumentRow | undefined> {
    const row = this.rows.get(id);
    if (row?.tenantId !== tenantId || row.status !== 'uploading') {
      return Promise.resolve(undefined);
    }
    Object.assign(row, { status: 'queued', s3VersionId, sizeBytes });
    this.jobs.push(id);
    return Promise.resolve(row);
  }

  findForIngestion(id: string): Promise<DocumentRow | undefined> {
    const row = this.rows.get(id);
    const ingesting = row && ['queued', 'processing'].includes(row.status) && row.s3VersionId;
    return Promise.resolve(ingesting ? row : undefined);
  }
}

/** In-memory versioned bucket. */
export class FakeDocumentStorage implements Pick<DocumentStorage, keyof DocumentStorage> {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string; versionId: string }>();
  readonly deletedVersions: string[] = [];
  private versions = 0;

  /** Simulates the browser's POST to S3. */
  put(key: string, bytes: Buffer | string, contentType = PDF_CONTENT_TYPE): string {
    const versionId = `v${++this.versions}`;
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType, versionId });
    return versionId;
  }

  createUploadPost(key: string): Promise<UploadPost> {
    return Promise.resolve({
      url: 'https://docs-bucket.s3.test/',
      fields: { key, 'Content-Type': PDF_CONTENT_TYPE },
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  }

  head(key: string): Promise<ObjectHead | undefined> {
    const obj = this.objects.get(key);
    return Promise.resolve(
      obj && {
        sizeBytes: obj.bytes.length,
        contentType: obj.contentType,
        versionId: obj.versionId,
      },
    );
  }

  readPrefix(key: string, versionId: string, length: number): Promise<Uint8Array> {
    const obj = this.objects.get(key);
    return Promise.resolve(
      obj?.versionId === versionId ? obj.bytes.subarray(0, length) : new Uint8Array(),
    );
  }

  deleteVersion(key: string, versionId: string): Promise<void> {
    if (this.objects.get(key)?.versionId === versionId) {
      this.objects.delete(key);
    }
    this.deletedVersions.push(`${key}@${versionId}`);
    return Promise.resolve();
  }

  presignGet(key: string, versionId: string, inlineFilename?: string): Promise<SignedUrl> {
    const inline = inlineFilename ? `&inline=${encodeURIComponent(inlineFilename)}` : '';
    return Promise.resolve({
      url: `https://docs-bucket.s3.test/${key}?versionId=${versionId}${inline}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  }
}
