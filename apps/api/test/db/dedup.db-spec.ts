import type { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDbTestApp, userClient } from '../support/db-app.js';

/**
 * File-level dedup through POST /api/documents against the real database (the unique index is
 * part of what is tested). Presigning is local, so the fake AWS keys in vitest.db.config.ts are
 * enough and nothing reaches S3.
 */
const url = process.env.TEST_DATABASE_URL;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(!url)('file-level dedup (POST /api/documents)', () => {
  const db = new pg.Pool({ connectionString: url, max: 2 });
  let app: INestApplication;
  let base: string;

  const create = (sub: string, sha256: string, filename = 'Handbook.pdf') =>
    userClient(base, sub)('POST', '/api/documents', { filename, sizeBytes: 1000, sha256 });

  const user = async () => {
    const sub = randomUUID();
    await userClient(base, sub)('GET', '/api/me');
    return sub;
  };

  const rowsFor = async (tenantId: string, sha256: string) =>
    (
      await db.query<{ id: string; status: string }>(
        'SELECT id, status FROM documents WHERE tenant_id = $1 AND sha256 = $2 ORDER BY created_at',
        [tenantId, sha256],
      )
    ).rows;

  beforeAll(async () => {
    ({ app, base } = await startDbTestApp('dedup.test'));
  });

  afterAll(async () => {
    await db.query("DELETE FROM users WHERE email LIKE '%@dedup.test'");
    await app.close();
    await db.end();
  });

  it('resumes an unfinished upload of the same file, and refuses a second copy once it is in', async () => {
    const sub = await user();
    const hash = sha(randomUUID());

    const first = await create(sub, hash);
    const again = await create(sub, hash, 'Handbook (1).pdf');

    expect([first.status, again.status]).toEqual([201, 201]);
    const firstBody = (await first.json()) as {
      document: { id: string };
      upload: { fields: Record<string, string> };
    };
    const againBody = (await again.json()) as { document: { id: string } };
    expect(againBody.document.id).toBe(firstBody.document.id);
    expect(firstBody.upload.fields['x-amz-checksum-sha256']).toBe(
      Buffer.from(hash, 'hex').toString('base64'),
    );

    await db.query("UPDATE documents SET status = 'ready' WHERE id = $1", [firstBody.document.id]);
    const third = await create(sub, hash);

    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({
      code: 'DUPLICATE_DOCUMENT',
      existingDocumentId: firstBody.document.id,
    });
    expect(await rowsFor(sub, hash)).toHaveLength(1);
  });

  it('dedups per tenant only, and lets a failed copy be uploaded again', async () => {
    const [owner, other] = [await user(), await user()];
    const hash = sha(randomUUID());
    const { document } = (await (await create(owner, hash)).json()) as { document: { id: string } };
    await db.query("UPDATE documents SET status = 'failed' WHERE id = $1", [document.id]);

    const retry = await create(owner, hash);
    const otherTenant = await create(other, hash);

    expect([retry.status, otherTenant.status]).toEqual([201, 201]);
    expect((await rowsFor(owner, hash)).map((r) => r.status)).toEqual(['failed', 'uploading']);
  });

  it('keeps one row when the same file is sent twice at the same moment', async () => {
    const sub = await user();
    const hash = sha(randomUUID());

    const responses = await Promise.all([create(sub, hash), create(sub, hash), create(sub, hash)]);

    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await rowsFor(sub, hash)).toHaveLength(1);
  });

  it('rejects a checksum that is not a lowercase hex SHA-256', async () => {
    const sub = await user();

    const res = await create(sub, 'NOT-A-HASH');

    expect(res.status).toBe(400);
  });
});
