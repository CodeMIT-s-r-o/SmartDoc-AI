import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

const USER_INFO_TIMEOUT_MS = 3000;

/**
 * Reads the caller's email from Cognito's userInfo endpoint with their own access token
 * (access tokens carry no email claim). Needs no IAM permissions.
 */
@Injectable()
export class CognitoUserInfoClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async getEmail(accessToken: string): Promise<string> {
    const url = `${this.config.get('COGNITO_DOMAIN', { infer: true })}/oauth2/userInfo`;
    let body: { email?: unknown };
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(USER_INFO_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`userInfo returned ${res.status}`);
      }
      body = (await res.json()) as { email?: unknown };
    } catch (error) {
      throw new ServiceUnavailableException('Identity provider unavailable', { cause: error });
    }
    if (typeof body.email !== 'string' || body.email.length === 0) {
      throw new ServiceUnavailableException('Identity provider returned no email');
    }
    return body.email;
  }
}
