import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { documents, ingestionJobs } from '../db/schema.js';

export type DocumentRow = typeof documents.$inferSelect;

export interface NewDocument {
  id: string;
  tenantId: string;
  title: string;
  originalFilename: string;
  s3Key: string;
  sizeBytes: number;
}

/** Every read and write is scoped by tenant; the only exception is the worker lookup. */
@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async countActive(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), ne(documents.status, 'deleting')));
    return row?.n ?? 0;
  }

  async insertUploading(doc: NewDocument): Promise<DocumentRow> {
    const [row] = await this.db
      .insert(documents)
      .values({ ...doc, status: 'uploading' })
      .returning();
    if (!row) {
      throw new Error('insert returned no row');
    }
    return row;
  }

  async findOwned(tenantId: string, id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)));
    return row;
  }

  listOwned(tenantId: string): Promise<DocumentRow[]> {
    return this.db
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), ne(documents.status, 'deleting')))
      .orderBy(desc(documents.createdAt));
  }

  async markUploadFailed(
    tenantId: string,
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.db
      .update(documents)
      .set({ status: 'failed', errorCode, errorMessage })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.tenantId, tenantId),
          eq(documents.status, 'uploading'),
        ),
      );
  }

  /**
   * Compare-and-set `uploading -> queued`, pinning the validated S3 version, and enqueue the
   * ingestion job in the same transaction (outbox). Returns undefined when the document was not
   * in `uploading` (already completed, failed, or owned by someone else).
   */
  queueForIngestion(
    tenantId: string,
    id: string,
    s3VersionId: string,
    sizeBytes: number,
  ): Promise<DocumentRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(documents)
        .set({ status: 'queued', s3VersionId, sizeBytes })
        .where(
          and(
            eq(documents.id, id),
            eq(documents.tenantId, tenantId),
            eq(documents.status, 'uploading'),
          ),
        )
        .returning();
      if (!row) {
        return undefined;
      }
      await tx.insert(ingestionJobs).values({ documentId: id });
      return row;
    });
  }

  /** Worker lookup (internal route): only documents that are being ingested, with a pinned version. */
  async findForIngestion(id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, id),
          inArray(documents.status, ['queued', 'processing']),
          isNotNull(documents.s3VersionId),
        ),
      );
    return row;
  }
}
