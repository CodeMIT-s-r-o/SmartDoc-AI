import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';

/** Every tenant object lives under `users/{tenantId}/...`; nothing outside that prefix is reachable. */
export const TENANT_PREFIX = 'users/';

/**
 * Grants exactly what the API needs for tenant documents: presigned POST/GET, HeadObject,
 * version-pinned reads and full-version deletes. Shared by the dev app role and the prod instance role.
 */
export function grantDocumentAccess(bucket: s3.IBucket, grantee: iam.IGrantable): void {
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'TenantObjects',
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:PutObject',
        's3:DeleteObject',
        's3:DeleteObjectVersion',
      ],
      resources: [bucket.arnForObjects(`${TENANT_PREFIX}*`)],
    }),
  );
  grantee.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'ListTenantPrefixes',
      actions: ['s3:ListBucket', 's3:ListBucketVersions'],
      resources: [bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${TENANT_PREFIX}*`] } },
    }),
  );
}
