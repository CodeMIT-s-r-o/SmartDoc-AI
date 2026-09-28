import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/test-app.js';
import {
  accessToken,
  foreignPrivateKey,
  signJwt,
  TEST_CLIENT_ID,
  TEST_ISSUER,
} from './support/tokens.js';

describe('authentication', () => {
  let t: TestApp;
  const get = (token?: string) => {
    const req = request(t.app.getHttpServer()).get('/api/me');
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  describe('rejects with 401', () => {
    const now = () => Math.floor(Date.now() / 1000);

    it.each([
      ['no Authorization header', () => undefined],
      ['a non-JWT bearer value', () => 'not-a-jwt'],
      [
        'a tampered payload',
        () => {
          const [header, , signature] = accessToken().split('.');
          const forged = Buffer.from(
            JSON.stringify({
              sub: randomUUID(),
              iss: TEST_ISSUER,
              client_id: TEST_CLIENT_ID,
              token_use: 'access',
              exp: now() + 3600,
            }),
          ).toString('base64url');
          return `${header}.${forged}.${signature}`;
        },
      ],
      [
        'a token signed with an unknown key',
        () =>
          signJwt(
            {
              sub: randomUUID(),
              iss: TEST_ISSUER,
              client_id: TEST_CLIENT_ID,
              token_use: 'access',
              exp: now() + 3600,
            },
            foreignPrivateKey,
          ),
      ],
      [
        'an ID token',
        () => accessToken({ token_use: 'id', aud: TEST_CLIENT_ID, client_id: undefined }),
      ],
      ['a token for another app client', () => accessToken({ client_id: 'some-other-client' })],
      [
        'a token from another user pool (e.g. dev token against prod)',
        () =>
          accessToken({
            iss: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_OtherPool',
          }),
      ],
      ['an expired token', () => accessToken({ iat: now() - 7200, exp: now() - 3600 })],
    ])('%s', async (_, token) => {
      const res = await get(token())
        .expect(401)
        .expect('Content-Type', /application\/problem\+json/);
      expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
      // Generic detail only: which check failed is never disclosed.
      expect(['Missing bearer token', 'Invalid access token']).toContain(res.body.detail);
    });
  });

  it('accepts a valid access token and creates the user on first sight', async () => {
    const sub = randomUUID();
    const token = accessToken({ sub, 'cognito:groups': ['admin'] });

    const res = await get(token).expect(200);

    expect(res.body).toEqual({
      id: sub,
      email: `${token.length}@test.dev`,
      isAdmin: true,
      dailyLimitUsd: 0.25,
      spentTodayUsd: 0,
    });
    expect(t.users.rows.has(sub)).toBe(true);
  });

  it('looks up the email only once per user', async () => {
    const sub = randomUUID();
    t.userInfo.getEmail.mockClear();

    await get(accessToken({ sub })).expect(200);
    await get(accessToken({ sub })).expect(200);

    expect(t.userInfo.getEmail).toHaveBeenCalledTimes(1);
  });

  it('is not admin without the admin group', async () => {
    const res = await get(accessToken()).expect(200);
    expect(res.body.isAdmin).toBe(false);
  });

  it('reports today’s spend from the usage row', async () => {
    const sub = randomUUID();
    await get(accessToken({ sub })).expect(200);
    t.users.spentToday.set(sub, '0.0003628400');

    const res = await get(accessToken({ sub })).expect(200);

    expect(res.body.spentTodayUsd).toBeCloseTo(0.00036284, 10);
  });

  it('keeps /api/health public', async () => {
    t.db.execute.mockResolvedValue({ rows: [] });
    await request(t.app.getHttpServer())
      .get('/api/health')
      .expect((res) => {
        expect(res.status).not.toBe(401);
      });
  });
});

describe('rate limiting', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('limits per user, so one user cannot exhaust another user’s quota', async () => {
    const heavy = randomUUID();
    const server = t.app.getHttpServer();
    const limit = Number(process.env.THROTTLE_LIMIT_PER_MINUTE);

    for (let i = 0; i < limit; i++) {
      await request(server)
        .get('/api/me')
        .set('Authorization', `Bearer ${accessToken({ sub: heavy })}`)
        .expect(200);
    }
    const blocked = await request(server)
      .get('/api/me')
      .set('Authorization', `Bearer ${accessToken({ sub: heavy })}`)
      .expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.code).toBe('RATE_LIMITED');

    await request(server)
      .get('/api/me')
      .set('Authorization', `Bearer ${accessToken()}`)
      .expect(200);
  });
});
