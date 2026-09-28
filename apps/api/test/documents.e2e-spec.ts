import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentKey, documentPrefix, MAX_UPLOAD_BYTES } from '../src/storage/document-storage.js';
import { createTestApp, type TestApp } from './support/test-app.js';
import { accessToken } from './support/tokens.js';

const PDF = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n';
const INTERNAL_TOKEN = 'test-internal-token-0123456789';

describe('documents', () => {
  let t: TestApp;

  /** A user with a stable token, so every request is the same tenant. */
  const user = () => {
    const sub = randomUUID();
    const token = accessToken({ sub });
    const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
    const server = () => request(t.app.getHttpServer());
    return {
      sub,
      create: (body: object = { filename: 'Handbook.pdf', sizeBytes: 1234 }) =>
        as(server().post('/api/documents').send(body)),
      complete: (id: string) => as(server().post(`/api/documents/${id}/complete`)),
      list: () => as(server().get('/api/documents')),
      get: (id: string) => as(server().get(`/api/documents/${id}`)),
      file: (id: string) => as(server().get(`/api/documents/${id}/file`)),
      remove: (id: string) => as(server().delete(`/api/documents/${id}`)),
    };
  };

  /** Reserve a document and "upload" the given bytes to its key, like the browser would. */
  const uploaded = async (u: ReturnType<typeof user>, bytes: string, contentType?: string) => {
    const res = await u.create().expect(201);
    const id = res.body.document.id as string;
    t.storage.put(documentKey(u.sub, id), bytes, contentType);
    return id;
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('POST /api/documents', () => {
    it('reserves a document under the caller’s prefix and returns a presigned POST', async () => {
      const u = user();

      const res = await u
        .create({ filename: 'Employee Handbook.PDF', sizeBytes: 5000 })
        .expect(201);

      const { document, upload } = res.body;
      expect(document).toMatchObject({
        title: 'Employee Handbook',
        originalFilename: 'Employee Handbook.PDF',
        status: 'uploading',
        sizeBytes: 5000,
      });
      expect(upload.fields.key).toBe(`users/${u.sub}/documents/${document.id}/original.pdf`);
      expect(upload.fields['Content-Type']).toBe('application/pdf');
    });

    it.each([
      ['a missing filename', { sizeBytes: 10 }],
      ['a non-PDF filename', { filename: 'notes.txt', sizeBytes: 10 }],
      ['a zero size', { filename: 'a.pdf', sizeBytes: 0 }],
    ])('rejects %s with 400 VALIDATION_FAILED', async (_, body) => {
      const res = await user()
        .create(body)
        .expect(400)
        .expect('Content-Type', /problem\+json/);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects files over 20 MB before anything is created', async () => {
      const u = user();
      const res = await u
        .create({ filename: 'big.pdf', sizeBytes: MAX_UPLOAD_BYTES + 1 })
        .expect(422);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect((await u.list().expect(200)).body).toEqual([]);
    });

    it('enforces the 50-document quota', async () => {
      const u = user();
      for (let i = 0; i < 50; i++) {
        await t.documents.insertUploading({
          id: randomUUID(),
          tenantId: u.sub,
          title: `doc ${i}`,
          originalFilename: `doc${i}.pdf`,
          s3Key: `users/${u.sub}/documents/${i}/original.pdf`,
          sizeBytes: 1,
        });
      }
      const res = await u.create().expect(422);
      expect(res.body.code).toBe('QUOTA_EXCEEDED');
    });

    it('leaves no reservation behind when presigning fails', async () => {
      const u = user();
      t.storage.failNextUploadPost = true;

      await u.create().expect(500);

      expect((await u.list().expect(200)).body).toEqual([]);
    });

    it('limits upload reservations to 10 per hour per user', async () => {
      const u = user();
      for (let i = 0; i < 10; i++) {
        await u.create().expect(201);
      }
      const res = await u.create().expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      await user().create().expect(201);
    });
  });

  describe('POST /api/documents/:id/complete', () => {
    it('queues a real PDF for ingestion, pinned to the validated version', async () => {
      const u = user();
      const id = await uploaded(u, PDF);

      const res = await u.complete(id).expect(202);

      expect(res.body).toMatchObject({ id, status: 'queued', sizeBytes: PDF.length });
      expect(t.documents.rows.get(id)?.s3VersionId).toMatch(/^v\d+$/);
      expect(t.documents.jobs).toContain(id);
    });

    it('rejects a text file renamed to .pdf, deletes that version and marks the document failed', async () => {
      const u = user();
      const id = await uploaded(u, 'just some text, not a PDF');

      const res = await u.complete(id).expect(422);

      expect(res.body).toMatchObject({ code: 'INVALID_FILE', detail: 'The file is not a PDF' });
      expect(t.storage.objects.has(documentKey(u.sub, id))).toBe(false);
      expect(t.storage.deletedVersions.some((v) => v.startsWith(documentKey(u.sub, id)))).toBe(
        true,
      );
      expect((await u.get(id).expect(200)).body).toMatchObject({
        status: 'failed',
        errorCode: 'INVALID_FILE',
      });
      expect(t.documents.jobs).not.toContain(id);
    });

    it('rejects an object stored with a non-PDF content type', async () => {
      const u = user();
      const id = await uploaded(u, PDF, 'text/plain');
      expect((await u.complete(id).expect(422)).body.code).toBe('INVALID_FILE');
    });

    it('answers 409 UPLOAD_NOT_FOUND when nothing was uploaded yet, and allows a retry', async () => {
      const u = user();
      const id = (await u.create().expect(201)).body.document.id as string;

      expect((await u.complete(id).expect(409)).body.code).toBe('UPLOAD_NOT_FOUND');

      t.storage.put(documentKey(u.sub, id), PDF);
      await u.complete(id).expect(202);
    });

    it('is not repeatable: a second complete is 409 INVALID_STATE and enqueues nothing', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      await u.complete(id).expect(202);
      const jobs = t.documents.jobs.length;

      expect((await u.complete(id).expect(409)).body.code).toBe('INVALID_STATE');
      expect(t.documents.jobs.length).toBe(jobs);
    });
  });

  describe('DELETE /api/documents/:id', () => {
    it('deletes a queued document: rows, job and every S3 version', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      await u.complete(id).expect(202);

      await u.remove(id).expect(204);

      expect((await u.get(id).expect(404)).body.code).toBe('NOT_FOUND');
      expect((await u.list().expect(200)).body).toEqual([]);
      expect(t.documents.jobs).not.toContain(id);
      expect(t.storage.objects.has(documentKey(u.sub, id))).toBe(false);
      expect(t.storage.deletedPrefixes).toContain(documentPrefix(u.sub, id));
    });

    it('deletes a document that is still uploading', async () => {
      const u = user();
      const id = (await u.create().expect(201)).body.document.id as string;

      await u.remove(id).expect(204);

      expect(t.documents.rows.has(id)).toBe(false);
    });

    it('stops the worker from fetching a deleted document', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      await u.complete(id).expect(202);
      await u.remove(id).expect(204);

      await request(t.app.getHttpServer())
        .post(`/internal/documents/${id}/download-url`)
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .expect(404);
    });

    it('is 404 the second time', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      await u.remove(id).expect(204);
      expect((await u.remove(id).expect(404)).body.code).toBe('NOT_FOUND');
    });

    it('still succeeds for the user when S3 cleanup fails (left for the reconciler)', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      t.storage.failNextPrefixDelete = true;

      await u.remove(id).expect(204);

      expect(t.documents.rows.has(id)).toBe(false);
    });
  });

  describe('tenant isolation', () => {
    it('hides another user’s document behind 404 on every route', async () => {
      const owner = user();
      const other = user();
      const id = await uploaded(owner, PDF);

      for (const res of [
        await other.get(id),
        await other.complete(id),
        await other.file(id),
        await other.remove(id),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      expect((await other.list().expect(200)).body).toEqual([]);
      expect(t.documents.rows.get(id)?.status).toBe('uploading');
    });

    it('treats a malformed id like an unknown one', async () => {
      expect((await user().get('not-a-uuid').expect(404)).body.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/documents/:id/file', () => {
    it('is only available once the document is ready', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      await u.complete(id).expect(202);
      expect((await u.file(id).expect(409)).body.code).toBe('INVALID_STATE');

      Object.assign(t.documents.rows.get(id)!, { status: 'ready' });
      const res = await u.file(id).expect(200);

      expect(res.body.url).toContain(`versionId=${t.documents.rows.get(id)?.s3VersionId}`);
      expect(res.body.url).toContain('inline=Handbook.pdf');
    });
  });

  describe('POST /internal/documents/:id/download-url', () => {
    const internal = (id: string, token?: string) => {
      const req = request(t.app.getHttpServer()).post(`/internal/documents/${id}/download-url`);
      return token === undefined ? req : req.set('X-Internal-Token', token);
    };

    it('requires the internal token (a Cognito token is not enough)', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      await u.complete(id).expect(202);

      await internal(id).expect(401);
      await internal(id, 'wrong-token-0123456789-abcdefg').expect(401);
      await internal(id)
        .set('Authorization', `Bearer ${accessToken({ sub: u.sub })}`)
        .expect(401);
    });

    it('returns a URL pinned to the validated version for a queued document', async () => {
      const u = user();
      const id = await uploaded(u, PDF);
      await u.complete(id).expect(202);

      const res = await internal(id, INTERNAL_TOKEN).expect(200);

      expect(res.body.url).toContain(`versionId=${t.documents.rows.get(id)?.s3VersionId}`);
      expect(res.body.url).not.toContain('inline=');
    });

    it('refuses documents that are not being ingested', async () => {
      const u = user();
      const id = (await u.create().expect(201)).body.document.id as string;
      await internal(id, INTERNAL_TOKEN).expect(404);
    });

    it('is not reachable under the public /api prefix', async () => {
      await request(t.app.getHttpServer())
        .post(`/api/internal/documents/${randomUUID()}/download-url`)
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .expect(404);
    });
  });
});
