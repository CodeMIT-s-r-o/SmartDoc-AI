import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AccessTokenVerifier } from '../../src/auth/access-token-verifier.js';
import { DB } from '../../src/db/db.module.js';
import { DocumentsRepository } from '../../src/documents/documents.repository.js';
import { DocumentStorage } from '../../src/storage/document-storage.js';
import { CognitoUserInfoClient } from '../../src/users/user-info.client.js';
import { type UserProfile, UsersRepository } from '../../src/users/users.repository.js';
import { FakeDocumentStorage, FakeDocumentsRepository } from './fake-documents.js';
import { TEST_JWKS } from './tokens.js';

/** In-memory stand-in for the users table. */
export class FakeUsersRepository implements Pick<UsersRepository, keyof UsersRepository> {
  readonly rows = new Map<string, { email: string }>();
  readonly spentToday = new Map<string, string>();

  touch(id: string): Promise<boolean> {
    return Promise.resolve(this.rows.has(id));
  }

  insert(user: { id: string; email: string }): Promise<void> {
    if (!this.rows.has(user.id)) {
      this.rows.set(user.id, { email: user.email });
    }
    return Promise.resolve();
  }

  getProfile(id: string): Promise<UserProfile | undefined> {
    const row = this.rows.get(id);
    return Promise.resolve(
      row && {
        email: row.email,
        dailyLimitUsd: '0.2500',
        spentTodayUsd: this.spentToday.get(id) ?? null,
      },
    );
  }
}

export interface TestApp {
  app: INestApplication;
  users: FakeUsersRepository;
  userInfo: { getEmail: ReturnType<typeof vi.fn> };
  db: { execute: ReturnType<typeof vi.fn> };
  documents: FakeDocumentsRepository;
  storage: FakeDocumentStorage;
}

/**
 * The real AppModule (guards, throttler, filter, controllers) with the database, the users and
 * documents tables, S3 and Cognito's userInfo endpoint replaced. Tokens are verified by the real verifier against TEST_JWKS.
 */
export async function createTestApp(): Promise<TestApp> {
  const users = new FakeUsersRepository();
  const userInfo = {
    getEmail: vi.fn((token: string) => Promise.resolve(`${token.length}@test.dev`)),
  };
  const db = { execute: vi.fn() };
  const documents = new FakeDocumentsRepository();
  const storage = new FakeDocumentStorage();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(UsersRepository)
    .useValue(users)
    .overrideProvider(CognitoUserInfoClient)
    .useValue(userInfo)
    .overrideProvider(DocumentsRepository)
    .useValue(documents)
    .overrideProvider(DocumentStorage)
    .useValue(storage)
    .compile();
  moduleRef.get(AccessTokenVerifier).cacheJwks(TEST_JWKS as never);

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, users, userInfo, db, documents, storage };
}
