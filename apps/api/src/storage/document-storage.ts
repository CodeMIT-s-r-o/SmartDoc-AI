import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProblemException } from '../common/problem.js';
import type { Env } from '../config/env.js';

/** Optional override (tests); by default the client uses the region and the default credential chain. */
export const S3_CLIENT = Symbol('S3_CLIENT');

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const PDF_CONTENT_TYPE = 'application/pdf';
const UPLOAD_TTL_S = 300;
const DOWNLOAD_TTL_S = 300;

export interface UploadPost {
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | undefined;
  versionId: string | undefined;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

/** Every tenant object lives under this prefix; the IAM policy grants nothing outside it. */
export const documentPrefix = (tenantId: string, documentId: string): string =>
  `users/${tenantId}/documents/${documentId}/`;

export const documentKey = (tenantId: string, documentId: string): string =>
  `${documentPrefix(tenantId, documentId)}original.pdf`;

const expiresAt = (ttlSeconds: number): string =>
  new Date(Date.now() + ttlSeconds * 1000).toISOString();

/** RFC 5987 filename for Content-Disposition, so non-ASCII titles survive. */
const inlineDisposition = (filename: string): string =>
  `inline; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

@Injectable()
export class DocumentStorage {
  private readonly bucket: string;
  private readonly s3: S3Client;

  constructor(config: ConfigService<Env, true>, @Optional() @Inject(S3_CLIENT) s3?: S3Client) {
    this.bucket = config.get('S3_DOCS_BUCKET', { infer: true });
    this.s3 = s3 ?? new S3Client({ region: config.get('AWS_REGION', { infer: true }) });
  }

  /**
   * Presigned POST, not PUT: only a POST policy can enforce the size range. The policy also pins
   * the exact key and the content type, and expires after 5 minutes.
   */
  /**
   * With `sha256` (hex), S3 hashes what arrives and rejects bytes that differ from the file the
   * browser hashed, so the dedup key always describes the stored object.
   */
  async createUploadPost(key: string, sha256?: string): Promise<UploadPost> {
    this.assertCredentialsFresh();
    const checksum: Record<string, string> = sha256
      ? {
          'x-amz-checksum-algorithm': 'SHA256',
          'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
        }
      : {};
    // Every field is also an exact-match condition in the signed policy.
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ['eq', '$Content-Type', PDF_CONTENT_TYPE],
      ],
      Fields: { 'Content-Type': PDF_CONTENT_TYPE, ...checksum },
      Expires: UPLOAD_TTL_S,
    });
    return { url, fields, expiresAt: expiresAt(UPLOAD_TTL_S) };
  }

  /**
   * Presigning is local, so expired credentials would silently produce URLs that S3 rejects.
   * Locally, `make creds` sets AWS_CREDENTIAL_EXPIRATION; instance-role credentials in prod
   * refresh themselves and never set it.
   */
  private assertCredentialsFresh(): void {
    const expiration = process.env.AWS_CREDENTIAL_EXPIRATION;
    if (expiration && Date.parse(expiration) <= Date.now()) {
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'UNAVAILABLE',
        'AWS credentials expired: run `make creds` and restart the api container',
      );
    }
  }

  async head(key: string): Promise<ObjectHead | undefined> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        sizeBytes: res.ContentLength ?? 0,
        contentType: res.ContentType,
        versionId: res.VersionId,
      };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return undefined;
      }
      throw error;
    }
  }

  /** The first bytes of one specific object version (magic-byte check). */
  async readPrefix(key: string, versionId: string, length: number): Promise<Uint8Array> {
    const res = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
        Range: `bytes=0-${length - 1}`,
      }),
    );
    return res.Body ? res.Body.transformToByteArray() : new Uint8Array();
  }

  /** Deleting by version id removes the bytes; a plain delete would only add a delete marker. */
  async deleteVersion(key: string, versionId: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }),
    );
  }

  /**
   * Removes every version and delete marker under a document's prefix, so no bytes survive in
   * the versioned bucket. Returns how many were deleted.
   */
  async deleteAllVersions(prefix: string): Promise<number> {
    let deleted = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const objects: ObjectIdentifier[] = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
        .filter((v) => v.Key)
        .map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
      if (objects.length > 0) {
        const res = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (res.Errors?.length) {
          throw new Error(`S3 could not delete ${res.Errors.length} object versions`);
        }
        deleted += objects.length;
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
    return deleted;
  }

  /** A short-lived GET pinned to a version; `inlineFilename` makes browsers display the PDF. */
  async presignGet(key: string, versionId: string, inlineFilename?: string): Promise<SignedUrl> {
    this.assertCredentialsFresh();
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      VersionId: versionId,
      ...(inlineFilename && {
        ResponseContentType: PDF_CONTENT_TYPE,
        ResponseContentDisposition: inlineDisposition(inlineFilename),
      }),
    });
    return {
      url: await getSignedUrl(this.s3, command, { expiresIn: DOWNLOAD_TTL_S }),
      expiresAt: expiresAt(DOWNLOAD_TTL_S),
    };
  }
}
