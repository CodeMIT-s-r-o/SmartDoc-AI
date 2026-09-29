/**
 * Writes the SSE event contract as JSON Schema, so the Python AI service can validate what it
 * emits against the same definition the TypeScript side parses with.
 *   yarn workspace @smartdoc/contracts build:schema
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sseEventSchema } from '../src/sse.js';

export const SCHEMA_PATH = fileURLToPath(
  new URL('../schema/sse-events.schema.json', import.meta.url),
);

export function renderSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(sseEventSchema, { target: 'draft-2020-12' }), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SCHEMA_PATH, renderSchema());
  console.log(`wrote ${SCHEMA_PATH}`);
}
