import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';
import { documents, ingestionJobs, messages, responseCache } from '../db/schema.js';

export type DocumentRow = typeof documents.$inferSelect;

export interface NewDocument {
  id: string;
  tenantId: string;
  title: string;
  originalFilename: string;
  s3Key: string;
  sizeBytes: number;
  sha256?: string | null;
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

  /** The tenant's live copy of these bytes (the same rows the dedup unique index covers). */
  async findBySha256(tenantId: string, sha256: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, tenantId),
          eq(documents.sha256, sha256),
          notInArray(documents.status, ['failed', 'deleting']),
        ),
      );
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

  /**
   * Step 1 of a delete: flip the document to `deleting` so it leaves chat scope and the worker's
   * finalize (which requires `processing`) rolls back. Returns the row, or undefined if the caller
   * does not own it or it is already being deleted.
   */
  async markDeleting(tenantId: string, id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .update(documents)
      .set({ status: 'deleting' })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.tenantId, tenantId),
          ne(documents.status, 'deleting'),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Step 2, one transaction: strip this document's snippets from past answers' citations (title
   * and pages stay, so old answers still say where they came from), then delete the row. Chunks and
   * jobs cascade; the cost ledger and retrieval telemetry have no FK and survive by design.
   */
  async purge(tenantId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({
          citations: sql`(
            SELECT jsonb_agg(CASE WHEN e->>'documentId' = ${id} THEN e - 'snippet' ELSE e END)
              FROM jsonb_array_elements(${messages.citations}) AS e
          )`,
        })
        .where(
          and(
            eq(messages.tenantId, tenantId),
            sql`${messages.citations} @> jsonb_build_array(jsonb_build_object('documentId', ${id}::text))`,
          ),
        );
      await tx.delete(documents).where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)));
      // Cached answers may quote the document's snippets; the cache refills on demand.
      await tx.delete(responseCache).where(eq(responseCache.tenantId, tenantId));
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
