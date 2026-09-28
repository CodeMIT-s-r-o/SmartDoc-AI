import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { Jwks } from 'aws-jwt-verify/jwk';
import type { Env } from '../config/env.js';

export interface AccessTokenClaims {
  sub: string;
  groups: string[];
}

function createVerifier(config: ConfigService<Env, true>) {
  return CognitoJwtVerifier.create({
    userPoolId: config.get('COGNITO_USER_POOL_ID', { infer: true }),
    // ID tokens and tokens issued to other app clients are rejected.
    tokenUse: 'access',
    clientId: config.get('COGNITO_CLIENT_ID', { infer: true }),
  });
}

/**
 * Verifies Cognito access tokens: RS256 signature against the pool's JWKS, issuer (this pool),
 * expiry, `token_use = access` and `client_id`. Stateless, so a revoked token stays valid until
 * it expires (at most 1 hour); see docs/IMPLEMENTATION_PLAN.md §9.
 */
@Injectable()
export class AccessTokenVerifier implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccessTokenVerifier.name);
  private readonly verifier: ReturnType<typeof createVerifier>;
  private jwksPreloaded = false;

  constructor(config: ConfigService<Env, true>) {
    this.verifier = createVerifier(config);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.jwksPreloaded) {
      return;
    }
    // Prefetch so the first request does not pay for it; verify() fetches lazily if this fails.
    try {
      await this.verifier.hydrate();
    } catch (error) {
      this.logger.warn(`JWKS prefetch failed, will retry on first request: ${String(error)}`);
    }
  }

  /** Supplies the JWKS directly instead of fetching it (tests). */
  cacheJwks(jwks: Jwks): void {
    this.verifier.cacheJwks(jwks);
    this.jwksPreloaded = true;
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    const payload = await this.verifier.verify(token);
    return { sub: payload.sub, groups: payload['cognito:groups'] ?? [] };
  }
}
