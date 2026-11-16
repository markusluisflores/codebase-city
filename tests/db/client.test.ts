import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, setDb } from '@/lib/db/client';

afterEach(() => {
  setDb(null);
  vi.unstubAllEnvs();
});

describe('getDb', () => {
  it('throws a fixed message naming the variable when it is missing', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => getDb()).toThrow('DATABASE_URL is not set');
  });

  it('never echoes a malformed connection string, password included', () => {
    vi.stubEnv('DATABASE_URL', '"postgresql://u:SECRETPW@ep-x.neon.tech/db"');
    let message = '';
    try {
      getDb();
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toBe('DATABASE_URL is not a valid postgres URL');
    expect(message).not.toContain('SECRETPW');
  });

  it('rejects a non-postgres URL', () => {
    vi.stubEnv('DATABASE_URL', 'https://u:SECRETPW@example.com/db');
    expect(() => getDb()).toThrow('DATABASE_URL is not a valid postgres URL');
  });
});
