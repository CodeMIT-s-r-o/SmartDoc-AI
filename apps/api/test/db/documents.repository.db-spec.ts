import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
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

  it('keeps updated_at current via the database trigger', async () => {
    const t = await tenant();
    const doc = await uploading(t);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const queued = await repo.queueForIngestion(t, doc.id, 'ver-1', 1);

    expect(queued!.updatedAt.getTime()).toBeGreaterThan(doc.updatedAt.getTime());
  });
});
