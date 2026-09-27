import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { configParam, type StageConfig } from './config.js';

export interface AuthStackProps extends StackProps {
  config: StageConfig;
}

export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { stage, webOrigins, protect } = props.config;
    const signInUrl = webOrigins[0];

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `smartdoc-${stage}`,
      // Essentials: managed login, free up to 10k MAU.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      // Invite-only: users are created by an admin (scripts/invite-user.sh).
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      userInvitation: {
        emailSubject: 'Your SmartDoc AI invitation',
        emailBody:
          'You have been invited to SmartDoc AI.<br><br>' +
          'Username: {username}<br>Temporary password: {####}<br><br>' +
          `Sign in at ${signInUrl} and choose a new password. The temporary password expires in 7 days.`,
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: protect,
      removalPolicy: protect ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `smartdoc-${stage}-codemit` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Public SPA client: authorization code + PKCE, no client secret.
    this.webClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'web',
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: webOrigins.map((origin) => `${origin}/auth/callback`),
        logoutUrls: webOrigins.map((origin) => `${origin}/`),
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(7),
    });

    // The newer managed login renders nothing without a style; use Cognito's default look.
    const branding = new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.webClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(this.domain);

    this.userPool.addGroup('AdminGroup', {
      groupName: 'admin',
      description: 'Operators: cost page, admin endpoints and per-user budget changes',
    });

    const authority = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;
    const params: Record<string, string> = {
      cognito_user_pool_id: this.userPool.userPoolId,
      cognito_client_id: this.webClient.userPoolClientId,
      cognito_domain: this.domain.baseUrl(),
      oidc_authority: authority,
    };
    for (const [name, value] of Object.entries(params)) {
      new ssm.StringParameter(this, `Param-${name}`, {
        parameterName: configParam(stage, name),
        stringValue: value,
      });
    }

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'WebClientId', { value: this.webClient.userPoolClientId });
    new CfnOutput(this, 'CognitoDomainUrl', { value: this.domain.baseUrl() });
    new CfnOutput(this, 'OidcAuthority', { value: authority });
  }
}
