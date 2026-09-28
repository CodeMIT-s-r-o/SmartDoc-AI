import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
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
