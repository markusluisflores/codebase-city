import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET } from '@/app/api/session/route';
import {
  clearedSessionCookieHeader,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  sessionStatus,
} from '@/lib/session';

// Obviously fake values, created here.
const SECRET = 'fake-session-secret-for-tests-0123456789';
const PASSWORD = 'fake-demo-password-for-tests';
const env = { DEMO_PASSWORD: PASSWORD, SESSION_SECRET: SECRET };

beforeEach(() => {
  vi.stubEnv('DEMO_PASSWORD', PASSWORD);
  vi.stubEnv('SESSION_SECRET', SECRET);
});
afterEach(() => vi.unstubAllEnvs());

const reqWith = (token?: string, method = 'GET') =>
  new Request('http://localhost/api/session', {
    method,
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });

describe('sessionStatus', () => {
  it('is locked without a cookie', async () => {
    expect(await sessionStatus(reqWith(), env)).toEqual({ unlocked: false });
  });

  it('is unlocked with a valid token and reports when it expires', async () => {
    const now = Date.UTC(2026, 10, 25, 12);
    const token = await createSessionToken(SECRET, now);
    expect(await sessionStatus(reqWith(token), env, now + 1000)).toEqual({
      unlocked: true,
      expiresAt: new Date(now + SESSION_MAX_AGE_S * 1000).toISOString(),
    });
  });

  it('is locked for a forged, tampered or expired token', async () => {
    const now = Date.UTC(2026, 10, 25, 12);
    const token = await createSessionToken(SECRET, now);
    expect(await sessionStatus(reqWith(`${token}x`), env, now)).toEqual({ unlocked: false });
    expect(await sessionStatus(reqWith('123.abc'), env, now)).toEqual({ unlocked: false });
    expect(await sessionStatus(reqWith(token), env, now + SESSION_MAX_AGE_S * 1000 + 1)).toEqual({
      unlocked: false,
    });
  });

  it('is locked (never throws) when the server is misconfigured', async () => {
    const token = await createSessionToken(SECRET);
    expect(await sessionStatus(reqWith(token), {})).toEqual({ unlocked: false });
  });
});

describe('GET /api/session', () => {
  it('answers no-store JSON with only the visitor’s own state', async () => {
    const res = await GET(reqWith(await createSessionToken(SECRET)));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'unlocked']);
    expect(body.unlocked).toBe(true);
  });

  it('answers locked without a cookie, and never sets a cookie', async () => {
    const res = await GET(reqWith());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlocked: false });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('DELETE /api/session', () => {
  it('clears the host-only cookie and answers 204 no-store', async () => {
    const res = await DELETE();
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toBe(clearedSessionCookieHeader());
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/;\s*HttpOnly/);
    expect(cookie).toMatch(/;\s*Secure/);
    expect(cookie).toMatch(/;\s*Path=\/(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
