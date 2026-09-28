import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

/** Values mirrored in vitest.config.ts so the real verifier config is exercised. */
export const TEST_POOL_ID = 'eu-central-1_TestPool1';
export const TEST_CLIENT_ID = 'test-web-client';
export const TEST_ISSUER = `https://cognito-idp.eu-central-1.amazonaws.com/${TEST_POOL_ID}`;

const KID = 'test-signing-key';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** JWKS the AccessTokenVerifier is preloaded with instead of fetching Cognito's. */
export const TEST_JWKS = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }],
};

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function signJwt(
  payload: Record<string, unknown>,
  key: typeof privateKey = privateKey,
): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(key);
  return `${header}.${body}.${b64url(signature)}`;
}

/** A Cognito-shaped access token; override any claim to build a negative case. */
export function accessToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const sub = (overrides.sub as string | undefined) ?? randomUUID();
  return signJwt({
    sub,
    iss: TEST_ISSUER,
    client_id: TEST_CLIENT_ID,
    token_use: 'access',
    scope: 'openid email',
    auth_time: now,
    iat: now,
    exp: now + 3600,
    jti: randomUUID(),
    username: sub,
    ...overrides,
  });
}

/** A key pair the verifier does not know, for forged-signature cases. */
export const foreignPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
