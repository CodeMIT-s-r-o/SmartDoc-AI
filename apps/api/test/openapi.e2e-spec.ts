import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createTestApp, type TestApp } from './support/test-app.js';
import { key, mountedRoutes } from './support/routes.js';

const SPEC = new URL('../../../docs/openapi.yaml', import.meta.url);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** docs/openapi.yaml describes exactly the routes the app mounts: none missing, none stale. */
describe('docs/openapi.yaml', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('documents every mounted route and nothing else', () => {
    const spec = parse(readFileSync(SPEC, 'utf8')) as { paths: Record<string, object> };
    const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((m) => METHODS.includes(m))
        .map((m) => key({ method: m.toUpperCase(), path: path.replace(/\{(\w+)\}/g, ':$1') })),
    );

    expect(documented.sort()).toEqual(mountedRoutes(t.app).map(key).sort());
  });
});
