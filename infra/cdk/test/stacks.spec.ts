import { App, type Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../lib/app.js';

const env = { account: '123456789012', region: 'eu-central-1' };

let app: App;
const template = (id: string): Template => Template.fromStack(app.node.findChild(id) as Stack);

beforeAll(() => {
  app = buildApp(new App(), env);
});

describe('storage', () => {
  it('locks the docs bucket down: private, encrypted, versioned, TLS-only', () => {
    const t = template('SmartDoc-Dev-Storage');
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'smartdoc-dev-docs-123456789012',
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          }),
        ],
      },
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('allows only localhost on dev and only the public origin on prod', () => {
    const cors = (id: string): unknown => {
      const [bucket] = Object.values(template(id).findResources('AWS::S3::Bucket'));
      return bucket?.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins;
    };
    expect(cors('SmartDoc-Dev-Storage')).toEqual(['http://localhost:5173']);
    expect(cors('SmartDoc-Prod-Storage')).toEqual(['https://smartdoc.codemit.sk']);
  });

  it('scopes the dev app role to users/* in the dev bucket', () => {
    const t = template('SmartDoc-Dev-Storage');
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'SmartDocDevApp',
      MaxSessionDuration: 3600,
    });
    const policies = t.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
    );
    const actions = statements.flatMap((s) => [s.Action].flat() as string[]);
    expect(actions.every((a) => a.startsWith('s3:'))).toBe(true);
    expect(actions).not.toContain('s3:*');
    const objects = statements.find((s) => s.Sid === 'TenantObjects');
    expect(JSON.stringify(objects?.Resource)).toContain('/users/*');
    const list = statements.find((s) => s.Sid === 'ListTenantPrefixes');
    expect(list?.Condition).toEqual({ StringLike: { 's3:prefix': ['users/*'] } });
  });

  it('creates no dev app role in prod and retains the prod bucket', () => {
    const t = template('SmartDoc-Prod-Storage');
    t.resourceCountIs('AWS::IAM::Role', 0);
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });
});

describe('auth', () => {
  it('is invite-only with a strong password policy and optional TOTP', () => {
    template('SmartDoc-Dev-Auth').hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      UserPoolTier: 'ESSENTIALS',
    });
  });

  it('uses a public PKCE client with code flow and dev-only localhost callbacks', () => {
    template('SmartDoc-Dev-Auth').hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email'],
      CallbackURLs: ['http://localhost:5173/auth/callback'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
    });
    template('SmartDoc-Prod-Auth').hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['https://smartdoc.codemit.sk/auth/callback'],
      LogoutURLs: ['https://smartdoc.codemit.sk/'],
    });
  });

  it('never mentions localhost anywhere in prod', () => {
    for (const id of ['SmartDoc-Prod-Storage', 'SmartDoc-Prod-Auth']) {
      expect(JSON.stringify(template(id).toJSON())).not.toContain('localhost');
    }
  });

  it('uses the newer managed login with the default style and an admin group', () => {
    const t = template('SmartDoc-Dev-Auth');
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'smartdoc-dev-codemit',
      ManagedLoginVersion: 2,
    });
    t.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: true,
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admin' });
  });

  it('protects the prod user pool from deletion', () => {
    template('SmartDoc-Prod-Auth').hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtection: 'ACTIVE' }),
    });
  });

  it('publishes the config the apps read from SSM', () => {
    const names = Object.values(
      template('SmartDoc-Dev-Auth').findResources('AWS::SSM::Parameter'),
    ).map((p) => p.Properties.Name as string);
    expect(names.sort()).toEqual([
      '/smartdoc/dev/config/cognito_client_id',
      '/smartdoc/dev/config/cognito_domain',
      '/smartdoc/dev/config/cognito_user_pool_id',
      '/smartdoc/dev/config/oidc_authority',
    ]);
  });
});
