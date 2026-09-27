import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DB } from '../src/db/db.module.js';

describe('GET /api/health', () => {
  let app: INestApplication;
  const execute = vi.fn();
  const fetchMock = vi.fn();

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB)
      .useValue({ execute })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    execute.mockReset();
    fetchMock.mockReset();
  });

  it('returns 200 when the database is reachable', async () => {
    execute.mockResolvedValue({ rows: [] });
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'up', ai: 'up', version: 'test' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ai.test:8000/internal/health',
      expect.anything(),
    );
  });

  it('reports the AI service without failing when only the AI service is down', async () => {
    execute.mockResolvedValue({ rows: [] });
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body).toMatchObject({ status: 'ok', db: 'up', ai: 'down' });
  });

  it('returns 503 when the database is unreachable', async () => {
    execute.mockRejectedValue(new Error('connect ECONNREFUSED'));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const res = await request(app.getHttpServer()).get('/api/health').expect(503);

    expect(res.body).toMatchObject({ status: 'error', db: 'down' });
  });
});
