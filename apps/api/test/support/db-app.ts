import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AccessTokenVerifier } from '../../src/auth/access-token-verifier.js';
import { CognitoUserInfoClient } from '../../src/users/user-info.client.js';
import { accessToken, TEST_JWKS } from './tokens.js';

export interface DbTestApp {
  app: INestApplication;
  base: string;
}

/**
 * The real AppModule on a random port against the test database; only Cognito's userInfo is
 * stubbed. Users get `<uuid>@<emailDomain>`, so a test file can delete exactly its own rows.
 */
export async function startDbTestApp(emailDomain: string): Promise<DbTestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CognitoUserInfoClient)
    .useValue({ getEmail: vi.fn(() => Promise.resolve(`${randomUUID()}@${emailDomain}`)) })
    .compile();
  moduleRef.get(AccessTokenVerifier).cacheJwks(TEST_JWKS as never);
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { app, base };
}

/** Requests as one signed-in user; `path` is relative to the server root. */
export const userClient =
  (base: string, sub: string) =>
  (method: string, path: string, body?: unknown, signal?: AbortSignal) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken({ sub })}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
