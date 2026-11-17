import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { setDb, type Db } from '@/lib/db/client';

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');

/**
 * Real Postgres (PGlite, compiled to WASM) with `db/schema.sql` applied, installed as the app's
 * connection. No network. `reset()` empties every table between tests.
 */
/** A `Db` over a PGlite instance (tests wrap it to inject failures). */
export function pgAdapter(pg: PGlite): Db {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
}

export async function useTestDb(): Promise<{ pg: PGlite; reset: () => Promise<void> }> {
  const pg = new PGlite();
  await pg.exec(SCHEMA);
  const db = pgAdapter(pg);
  setDb(db);
  return {
    pg,
    reset: async () => {
      await pg.exec('TRUNCATE analyses, jobs, usage_counters, login_attempts');
    },
  };
}
