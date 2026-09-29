import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderSchema, SCHEMA_PATH } from '../scripts/build-schema.js';

describe('schema/sse-events.schema.json', () => {
  it('is up to date with the zod contract (run: yarn workspace @smartdoc/contracts build:schema)', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(renderSchema());
  });
});
