import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { DocumentStorage, documentKey, MAX_UPLOAD_BYTES } from './document-storage.js';

// Signing is local: fake credentials are enough, and nothing is sent to AWS.
const s3 = new S3Client({
  region: 'eu-central-1',
  credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' },
});
const config = {
  get: (key: keyof Env) =>
    ({ S3_DOCS_BUCKET: 'smartdoc-test-docs', AWS_REGION: 'eu-central-1' })[key as string],
} as unknown as ConfigService<Env, true>;
const storage = new DocumentStorage(config, s3);

describe('DocumentStorage.createUploadPost', () => {
  it('signs a policy that pins the key, the size range and the content type for 5 minutes', async () => {
    const key = documentKey('tenant-1', 'doc-1');

    const post = await storage.createUploadPost(key);

    const policy = JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8')) as {
      expiration: string;
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket: 'smartdoc-test-docs' },
        { key },
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ['eq', '$Content-Type', 'application/pdf'],
      ]),
    );
    const ttl = (Date.parse(policy.expiration) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
    expect(post.fields.key).toBe(key);
    expect(post.fields['Content-Type']).toBe('application/pdf');
  });

  it("pins the browser's SHA-256, so S3 rejects bytes that differ from the hashed file", async () => {
    // SHA-256 of the empty string, a well-known value: e3b0c442…b855 hex, 47DEQpj8…Uk= base64.
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const post = await storage.createUploadPost(documentKey('tenant-1', 'doc-1'), sha256);

    const policy = JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    const base64 = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
    expect(post.fields['x-amz-checksum-algorithm']).toBe('SHA256');
    expect(post.fields['x-amz-checksum-sha256']).toBe(base64);
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { 'x-amz-checksum-algorithm': 'SHA256' },
        { 'x-amz-checksum-sha256': base64 },
      ]),
    );
  });
});

describe('DocumentStorage.presignGet', () => {
  it('pins the version and encodes non-ASCII filenames (RFC 5987)', async () => {
    const { url } = await storage.presignGet(
      'users/t/documents/d/original.pdf',
      'ver123',
      'Smernica č. 5 (2026).pdf',
    );

    const params = new URL(url).searchParams;
    expect(params.get('versionId')).toBe('ver123');
    expect(params.get('response-content-type')).toBe('application/pdf');
    expect(params.get('response-content-disposition')).toBe(
      "inline; filename*=UTF-8''Smernica%20%C4%8D.%205%20%282026%29.pdf",
    );
    expect(Number(params.get('X-Amz-Expires'))).toBe(300);
  });
});

describe('expired local credentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to presign with credentials that have already expired', async () => {
    vi.stubEnv('AWS_CREDENTIAL_EXPIRATION', new Date(Date.now() - 1000).toISOString());

    await expect(storage.presignGet('users/t/k', 'v1')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await expect(storage.createUploadPost('users/t/k')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('presigns while they are still valid', async () => {
    vi.stubEnv('AWS_CREDENTIAL_EXPIRATION', new Date(Date.now() + 60_000).toISOString());
    await expect(storage.presignGet('users/t/k', 'v1')).resolves.toHaveProperty('url');
  });
});
