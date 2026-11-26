import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sessionRoute from '@/app/api/session/route';
import { setDb } from '@/lib/db/client';
import { pgAdapter, useTestDb } from '../helpers/pgliteDb';
import { PASSWORD, stubSessionEnv } from '../helpers/flowHelpers';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(async () => {
  await t.reset();
  setDb(pgAdapter(t.pg));
  stubSessionEnv();
});
afterEach(() => vi.unstubAllEnvs());

const login = (password: string, ip = '203.0.113.9') =>
  sessionRoute.POST(
    new Request('http://localhost/api/session', {
      method: 'POST',
      body: JSON.stringify({ password }),
      headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip },
    }),
  );

describe('POST /api/session wired to the Postgres attempt store', () => {
  it('runs on the Node runtime and exports only POST (log in), GET (own status) and DELETE (lock)', () => {
    expect(sessionRoute.runtime).toBe('nodejs');
    expect(Object.keys(sessionRoute).sort()).toEqual(['DELETE', 'GET', 'POST', 'runtime']);
  });

  it('accepts the right password and sets the cookie', async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it('limits a wrong-password guesser after 5 attempts a minute, per IP, without storing the raw IP', async () => {
    for (let i = 0; i < 5; i++) expect((await login('wrong-guess-value')).status).toBe(401);
    expect((await login('wrong-guess-value')).status).toBe(429);
    expect((await login(PASSWORD)).status).toBe(429); // the right password is refused while locked out
    expect((await login(PASSWORD, '198.51.100.7')).status).toBe(204); // other IPs unaffected
    const rows = await t.pg.query<{ ip_hash: string }>('SELECT ip_hash FROM login_attempts');
    expect(JSON.stringify(rows.rows)).not.toContain('203.0.113.9');
  });
});
