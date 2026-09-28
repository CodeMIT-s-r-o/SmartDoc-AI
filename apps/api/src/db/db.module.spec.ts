import { describe, expect, it } from 'vitest';
import { createPool } from './db.module.js';

describe('createPool', () => {
  it('survives an idle connection dying (e.g. a Postgres restart) instead of crashing', async () => {
    const pool = createPool('postgres://user:pass@127.0.0.1:1/db');

    // Without a listener, EventEmitter throws on 'error': this is what took the API down.
    expect(() =>
      pool.emit('error', new Error('terminating connection due to administrator command')),
    ).not.toThrow();

    await pool.end();
  });
});
