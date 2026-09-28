import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('GET /api/health', () => {
  let t: TestApp;
  const fetchMock = vi.fn();

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    t.db.execute.mockReset();
    fetchMock.mockReset();
  });

  it('returns 200 when the database is reachable, without a token', async () => {
    t.db.execute.mockResolvedValue({ rows: [] });
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await request(t.app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'up', ai: 'up', version: 'test' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ai.test:8000/internal/health',
      expect.anything(),
    );
  });

  it('reports the AI service without failing when only the AI service is down', async () => {
    t.db.execute.mockResolvedValue({ rows: [] });
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(t.app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body).toMatchObject({ status: 'ok', db: 'up', ai: 'down' });
  });

  it('returns 503 when the database is unreachable', async () => {
    t.db.execute.mockRejectedValue(new Error('connect ECONNREFUSED'));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await request(t.app.getHttpServer()).get('/api/health').expect(503);

    expect(res.body).toMatchObject({ status: 'error', db: 'down' });
  });

  it('is never rate limited (container health checks)', async () => {
    t.db.execute.mockResolvedValue({ rows: [] });
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const limit = Number(process.env.THROTTLE_LIMIT_PER_MINUTE);

    for (let i = 0; i <= limit + 1; i++) {
      await request(t.app.getHttpServer()).get('/api/health').expect(200);
    }
  });
});
