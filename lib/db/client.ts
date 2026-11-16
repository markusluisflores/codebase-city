import { neon } from '@neondatabase/serverless';

/**
 * The only database surface the app uses: one parameterised statement, rows back. Values are always
 * passed as `params` ($1, $2, ...), never concatenated into `text`. Each call is one autocommitted
 * statement, so multi-step logic is built from atomic single statements, not transactions.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

let current: Db | null = null;

/** Replaces the connection (tests pass a PGlite adapter; `null` goes back to the environment). */
export function setDb(db: Db | null): void {
  current = db;
}

/** The shared connection, created lazily from the `DATABASE_URL` environment variable. */
export function getDb(): Db {
  if (current) return current;
  const url = process.env.DATABASE_URL;
  // The message names the variable only: the value is a secret and must never be echoed.
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = neon(url);
  current = {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await sql.query(text, params)) as T[];
    },
  };
  return current;
}
