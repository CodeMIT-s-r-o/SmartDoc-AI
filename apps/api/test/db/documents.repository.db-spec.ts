import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import { DocumentsRepository } from '../../src/documents/documents.repository.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('DocumentsRepository (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  const repo = new DocumentsRepository(db);
  const tenants: string[] = [];

  const tenant = async (): Promise<string> => {
    const id = randomUUID();
    await db.insert(schema.users).values({ id, email: `${id}@db-spec.test` });
    tenants.push(id);
    return id;
  };

  const uploading = (tenantId: string) =>
    repo.insertUploading({
      id: randomUUID(),
      tenantId,
      title: 'Handbook',
      originalFilename: 'Handbook.pdf',
      s3Key: `users/${tenantId}/documents/x/original.pdf`,
      sizeBytes: 1000,
    });

  const jobsFor = (documentId: string) =>
    db.select().from(schema.ingestionJobs).where(eq(schema.ingestionJobs.documentId, documentId));

  beforeAll(async () => {
    await db.execute('select 1');
  });

  afterAll(async () => {
    // Cascades to documents and jobs.
    if (tenants.length) {
      await db.delete(schema.users).where(inArray(schema.users.id, tenants));
    }
    await pool.end();
  });

  it('queues once: status, pinned version and a single job in one transaction', async () => {
    const t = await tenant();
    const doc = await uploading(t);

    const queued = await repo.queueForIngestion(t, doc.id, 'ver-1', 1234);

    expect(queued).toMatchObject({ status: 'queued', s3VersionId: 'ver-1', sizeBytes: 1234 });
    expect(await jobsFor(doc.id)).toHaveLength(1);
    expect((await jobsFor(doc.id))[0]).toMatchObject({ status: 'queued', attempts: 0 });

    expect(await repo.queueForIngestion(t, doc.id, 'ver-2', 1234)).toBeUndefined();
    expect(await jobsFor(doc.id)).toHaveLength(1);
    expect((await repo.findOwned(t, doc.id))?.s3VersionId).toBe('ver-1');
  });

  it('never lets another tenant read, fail or queue a document', async () => {
    const owner = await tenant();
    const other = await tenant();
    const doc = await uploading(owner);

    expect(await repo.findOwned(other, doc.id)).toBeUndefined();
    expect(await repo.listOwned(other)).toEqual([]);
    expect(await repo.queueForIngestion(other, doc.id, 'ver-x', 1)).toBeUndefined();
    await repo.markUploadFailed(other, doc.id, 'INVALID_FILE', 'nope');

    expect((await repo.findOwned(owner, doc.id))?.status).toBe('uploading');
    expect(await jobsFor(doc.id)).toHaveLength(0);
  });

  it('only fails documents that are still uploading', async () => {
    const t = await tenant();
    const doc = await uploading(t);
    await repo.queueForIngestion(t, doc.id, 'ver-1', 1);

    await repo.markUploadFailed(t, doc.id, 'INVALID_FILE', 'late');

    expect((await repo.findOwned(t, doc.id))?.status).toBe('queued');
  });

  it('counts active documents per tenant and exposes only ingesting ones to the worker', async () => {
    const t = await tenant();
    const a = await uploading(t);
    await uploading(t);
    await repo.queueForIngestion(t, a.id, 'ver-a', 1);

    expect(await repo.countActive(t)).toBe(2);
    expect((await repo.findForIngestion(a.id))?.id).toBe(a.id);
    const [stillUploading] = (await repo.listOwned(t)).filter((d) => d.status === 'uploading');
    expect(await repo.findForIngestion(stillUploading!.id)).toBeUndefined();
  });

  it('purges a document: cascades chunks and jobs, redacts citation snippets, keeps the ledger', async () => {
    const t = await tenant();
    const doc = await uploading(t);
    const other = await uploading(t);
    await repo.queueForIngestion(t, doc.id, 'ver-1', 1);
    await db.execute(sql`
      INSERT INTO chunks (document_id, tenant_id, chunk_index, content, page_start, page_end,
                          char_start, token_count, content_hash, embedding_model, embedding)
      VALUES (${doc.id}, ${t}, 0, 'text', 1, 1, 0, 1, 'h', 'text-embedding-3-small',
              array_fill(0.1, ARRAY[1536])::halfvec)`);
    await db.execute(sql`
      INSERT INTO llm_calls (tenant_id, purpose, model, input_tokens, document_id)
      VALUES (${t}, 'doc_embed', 'text-embedding-3-small', 100, ${doc.id})`);
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ tenantId: t })
      .returning();
    const citation = (documentId: string, n: number) => ({
      n,
      chunkId: randomUUID(),
      documentId,
      title: 'Handbook',
      section: null,
      pageStart: 1,
      pageEnd: 1,
      snippet: 'secret text',
      score: 0.9,
      cited: true,
    });
    const [message] = await db
      .insert(schema.messages)
      .values({
        conversationId: conversation!.id,
        tenantId: t,
        role: 'assistant',
        content: 'answer [1][2]',
        citations: [citation(doc.id, 1), citation(other.id, 2)],
      })
      .returning();

    expect(await repo.markDeleting(t, doc.id)).toBeDefined();
    expect(await repo.markDeleting(t, doc.id)).toBeUndefined();
    await repo.purge(t, doc.id);

    expect(await repo.findOwned(t, doc.id)).toBeUndefined();
    expect(await jobsFor(doc.id)).toHaveLength(0);
    const count = async (query: ReturnType<typeof sql>) =>
      ((await db.execute(query)).rows[0] as { n: number }).n;
    expect(
      await count(sql`SELECT count(*)::int AS n FROM chunks WHERE document_id = ${doc.id}`),
    ).toBe(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM llm_calls WHERE document_id = ${doc.id}`),
    ).toBe(1);
    const [after] = await db
      .select({ citations: schema.messages.citations })
      .from(schema.messages)
      .where(eq(schema.messages.id, message!.id));
    const [redacted, kept] = after!.citations!;
    expect(redacted).toMatchObject({ documentId: doc.id, title: 'Handbook', pageStart: 1 });
    expect(redacted).not.toHaveProperty('snippet');
    expect(kept).toMatchObject({ documentId: other.id, snippet: 'secret text' });
  });

  it('never lets another tenant mark a document as deleting', async () => {
    const owner = await tenant();
    const other = await tenant();
    const doc = await uploading(owner);

    expect(await repo.markDeleting(other, doc.id)).toBeUndefined();
    await repo.purge(other, doc.id);

    expect((await repo.findOwned(owner, doc.id))?.status).toBe('uploading');
  });

  it('keeps updated_at current via the database trigger', async () => {
    const t = await tenant();
    const doc = await uploading(t);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const queued = await repo.queueForIngestion(t, doc.id, 'ver-1', 1);

    expect(queued!.updatedAt.getTime()).toBeGreaterThan(doc.updatedAt.getTime());
  });
});
