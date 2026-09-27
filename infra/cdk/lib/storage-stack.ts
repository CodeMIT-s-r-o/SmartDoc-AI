import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { configParam, type StageConfig } from './config.js';
import { grantDocumentAccess } from './document-access.js';

export interface StorageStackProps extends StackProps {
  config: StageConfig;
  /**
   * Dev only: principal allowed to assume `SmartDocDevApp`. Defaults to the account root, so any
   * IAM principal in the account that is itself allowed `sts:AssumeRole` can use it.
   */
  devAppTrustedPrincipalArn?: string;
}

export class StorageStack extends Stack {
  readonly docsBucket: s3.Bucket;
  readonly devAppRole?: iam.Role;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { stage, webOrigins, protect } = props.config;

    this.docsBucket = new s3.Bucket(this, 'DocsBucket', {
      bucketName: `smartdoc-${stage}-docs-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Versioning lets the worker read exactly the version /complete validated (no re-upload TOCTOU).
      versioned: true,
      cors: [
        {
          allowedOrigins: webOrigins,
          allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'x-amz-version-id'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'abort-multipart-expire-noncurrent',
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !protect,
    });

    new ssm.StringParameter(this, 'DocsBucketParam', {
      parameterName: configParam(stage, 'docs_bucket'),
      stringValue: this.docsBucket.bucketName,
    });
    new CfnOutput(this, 'DocsBucketName', { value: this.docsBucket.bucketName });

    if (stage === 'dev') {
      // Local containers get these narrow credentials via `make creds`, never the developer's own.
      this.devAppRole = new iam.Role(this, 'DevAppRole', {
        roleName: 'SmartDocDevApp',
        description: 'Local api container: dev docs bucket, users/* only',
        assumedBy: props.devAppTrustedPrincipalArn
          ? new iam.ArnPrincipal(props.devAppTrustedPrincipalArn)
          : new iam.AccountRootPrincipal(),
        maxSessionDuration: Duration.hours(1),
      });
      grantDocumentAccess(this.docsBucket, this.devAppRole);
      new CfnOutput(this, 'DevAppRoleArn', { value: this.devAppRole.roleArn });
    }
  }
}
