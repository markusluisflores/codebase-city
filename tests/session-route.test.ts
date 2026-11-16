import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as analyzePost } from '@/app/api/analyze/route';
import { POST as sessionPost } from '@/app/api/session/route';
import { handleLogin } from '@/lib/login';
import { config as proxyConfig, proxy } from '@/proxy';
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE_S } from '@/lib/session';
import { fakeLoginAttempts } from './helpers/fakeLoginAttempts';

// Obviously fake values, created here.
const PASSWORD = 'fake-demo-password-for-tests';
const SECRET = 'fake-session-secret-for-tests-0123456789';
const env = { DEMO_PASSWORD: PASSWORD, SESSION_SECRET: SECRET };

const loginReq = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  new Request('http://localhost/api/session', {
    method: 'POST',
    body: raw ?? JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-vercel-forwarded-for': '203.0.113.9',
      ...headers,
    },
  });

beforeEach(() => {
  vi.stubEnv('DEMO_PASSWORD', PASSWORD);
  vi.stubEnv('SESSION_SECRET', SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe('login handler', () => {
  it('sets a signed, HttpOnly, Secure, SameSite=Lax cookie with an expiry on the right password', async () => {
    const res = await handleLogin(loginReq({ password: PASSWORD }), {
      store: fakeLoginAttempts(),
      env,
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/;\s*HttpOnly/);
    expect(cookie).toMatch(/;\s*Secure/);
    expect(cookie).toMatch(/;\s*SameSite=Lax/);
    expect(cookie).toMatch(/;\s*Path=\/(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_S}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(cookie).not.toContain(PASSWORD);
    expect(cookie).not.toContain(SECRET);
  });

  it('rejects a wrong password with 401, a fixed message and no cookie', async () => {
    const res = await handleLogin(loginReq({ password: PASSWORD + 'x' }), {
      store: fakeLoginAttempts(),
      env,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toEqual({ error: 'wrong_password' });
  });

  it('gives the same response for a near miss and a far miss', async () => {
    const store = fakeLoginAttempts();
    const a = await handleLogin(loginReq({ password: PASSWORD.slice(0, -1) }), { store, env });
    const b = await handleLogin(loginReq({ password: 'zzz' }), { store, env });
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it.each([
    ['missing field', { nope: true }],
    ['non-string', { password: 12345 }],
    ['empty', { password: '' }],
    ['too long', { password: 'a'.repeat(201) }],
    ['array', [PASSWORD]],
  ])('rejects a malformed body (%s) with 400 and records nothing', async (_n, body) => {
    const store = fakeLoginAttempts();
    const res = await handleLogin(loginReq(body), { store, env });
    expect(res.status).toBe(400);
    expect(store.failures.size).toBe(0);
  });

  it('rejects invalid JSON, a huge body and a non-JSON content type', async () => {
    const store = fakeLoginAttempts();
    expect((await handleLogin(loginReq(null, {}, '{not json'), { store, env })).status).toBe(400);
    expect((await handleLogin(loginReq(null, {}, 'x'.repeat(5000)), { store, env })).status).toBe(
      400,
    );
    const form = loginReq(
      null,
      { 'content-type': 'application/x-www-form-urlencoded' },
      `password=${PASSWORD}`,
    );
    const res = await handleLogin(form, { store, env });
    expect(res.status).toBe(415);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('is rate-limited after 5 wrong attempts a minute per IP, even for the right password', async () => {
    const store = fakeLoginAttempts();
    const t0 = new Date('2026-11-16T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      const r = await handleLogin(loginReq({ password: `wrong-${i}` }), {
        store,
        env,
        now: () => t0,
      });
      expect(r.status).toBe(401);
    }
    const blocked = await handleLogin(loginReq({ password: PASSWORD }), {
      store,
      env,
      now: () => t0,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect(blocked.headers.get('set-cookie')).toBeNull();
    expect(await blocked.json()).toEqual({ error: 'too_many_attempts' });
    // Blocked attempts are not recorded again, so the window ends 60 s after the 5th failure.
    expect(store.failures.get('203.0.113.9')).toHaveLength(5);
    const later = new Date(t0.getTime() + 61_000);
    expect(
      (await handleLogin(loginReq({ password: PASSWORD }), { store, env, now: () => later }))
        .status,
    ).toBe(204);
  });

  it('limits per IP: another IP is unaffected', async () => {
    const store = fakeLoginAttempts();
    for (let i = 0; i < 5; i++) await handleLogin(loginReq({ password: 'bad' }), { store, env });
    const other = loginReq({ password: PASSWORD }, { 'x-vercel-forwarded-for': '198.51.100.4' });
    expect((await handleLogin(other, { store, env })).status).toBe(204);
  });

  it('cannot dodge the limit by spoofing x-forwarded-for', async () => {
    const store = fakeLoginAttempts();
    for (let i = 0; i < 5; i++) {
      await handleLogin(loginReq({ password: 'bad' }, { 'x-forwarded-for': `10.0.0.${i}` }), {
        store,
        env,
      });
    }
    const spoofed = loginReq({ password: PASSWORD }, { 'x-forwarded-for': '10.9.9.9' });
    expect((await handleLogin(spoofed, { store, env })).status).toBe(429);
  });

  it('fails closed (503, no cookie) when the attempt store is unavailable', async () => {
    const broken = {
      recordFailedLogin: async () => {
        throw new Error('db down');
      },
      tooManyAttempts: async () => {
        throw new Error('db down');
      },
    };
    const res = await handleLogin(loginReq({ password: PASSWORD }), { store: broken, env });
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses to run with a weak or missing configuration, without echoing values', async () => {
    const weak = { DEMO_PASSWORD: 'short-pass', SESSION_SECRET: SECRET };
    const res = await handleLogin(loginReq({ password: 'short-pass' }), {
      store: fakeLoginAttempts(),
      env: weak,
    });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('short-pass');
  });

  it('never logs the password, the secret or the visitor IP', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const store = fakeLoginAttempts();
    await handleLogin(loginReq({ password: 'a-wrong-guess-value' }), { store, env });
    await handleLogin(loginReq({ password: PASSWORD }), { store, env });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const s of ['a-wrong-guess-value', PASSWORD, SECRET, '203.0.113.9'])
      expect(logged).not.toContain(s);
    spies.forEach((s) => s.mockRestore());
  });

  it('the exported route refuses (503) until the Task 12a store is wired in', async () => {
    const res = await sessionPost(new NextRequest(loginReq({ password: PASSWORD })));
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/analyze handler (called directly, bypassing proxy.ts)', () => {
  const analyze = (cookie?: string) =>
    analyzePost(
      new NextRequest('http://localhost/api/analyze', {
        method: 'POST',
        body: JSON.stringify({ repo: 'a/b' }),
        headers: cookie
          ? { cookie, 'content-type': 'application/json' }
          : { 'content-type': 'application/json' },
      }),
    );

  it('returns 401 without a cookie, with a garbage cookie and with a tampered cookie', async () => {
    expect((await analyze()).status).toBe(401);
    expect((await analyze(`${SESSION_COOKIE}=garbage`)).status).toBe(401);
    const token = await createSessionToken(SECRET);
    expect((await analyze(`${SESSION_COOKIE}=${token}x`)).status).toBe(401);
  });

  it('returns 401 for an expired token and for one signed with another secret', async () => {
    const old = await createSessionToken(SECRET, Date.now() - (SESSION_MAX_AGE_S * 1000 + 1000));
    expect((await analyze(`${SESSION_COOKIE}=${old}`)).status).toBe(401);
    const other = await createSessionToken('another-fake-secret-for-tests-0123456789');
    expect((await analyze(`${SESSION_COOKIE}=${other}`)).status).toBe(401);
  });

  it('passes the session check with a valid cookie (the body is completed in Task 12b)', async () => {
    const token = await createSessionToken(SECRET);
    expect((await analyze(`${SESSION_COOKIE}=${token}`)).status).toBe(501);
  });

  it('denies when the server is misconfigured, even with a cookie signed by the configured secret', async () => {
    const token = await createSessionToken(SECRET);
    vi.stubEnv('DEMO_PASSWORD', 'short');
    expect((await analyze(`${SESSION_COOKIE}=${token}`)).status).toBe(503);
  });
});

describe('proxy.ts gate', () => {
  const req = (path: string, method = 'POST', cookie?: string) =>
    new NextRequest(`http://localhost${path}`, { method, headers: cookie ? { cookie } : {} });
  const isNext = (res: Response) => res.headers.get('x-middleware-next') === '1';

  it('matches every /api path, so a new route cannot slip past a narrow matcher', () => {
    expect(proxyConfig.matcher).toEqual(['/api/:path*']);
  });

  it('answers 401 JSON to POST /api/analyze without a session', async () => {
    const res = await proxy(req('/api/analyze'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lets a valid session through', async () => {
    const token = await createSessionToken(SECRET);
    expect(isNext(await proxy(req('/api/analyze', 'POST', `${SESSION_COOKIE}=${token}`)))).toBe(
      true,
    );
  });

  it.each([
    '/api/analyze/',
    '/api/analyze//',
    '/api//analyze',
    '/api/Analyze',
    '/API/ANALYZE',
    '/api/%61nalyze',
    '/api/%41NALYZE',
    '/api/%2561nalyze',
    '/api/analyze%2F',
    '/api/analyze/extra',
    '/api/./analyze',
    '/api/x/../analyze',
    '/api/analyze;x=1',
    '/api/analyze%00',
    '/api/%E0%A4%A',
  ])('gates the path trick %s', async (path) => {
    const res = await proxy(req(path));
    expect(res.status).toBe(401);
  });

  it.each(['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    'gates %s on /api/analyze too',
    async (method) => {
      expect((await proxy(req('/api/analyze', method))).status).toBe(401);
    },
  );

  it('keeps the login, job status and every public viewer path open', async () => {
    for (const [path, method] of [
      ['/api/session', 'POST'],
      ['/api/jobs/6f1c1f0e-0000-4000-8000-000000000000', 'GET'],
      ['/', 'GET'],
      ['/gate', 'GET'],
      ['/r/vercel/next.js', 'GET'],
      ['/gallery/vercel__next.js.json', 'GET'],
    ] as const) {
      const res = await proxy(req(path, method));
      expect(isNext(res), path).toBe(true);
    }
  });

  it('does not treat a lookalike route as the analyze route', async () => {
    expect(isNext(await proxy(req('/api/analyzer')))).toBe(true);
    expect(isNext(await proxy(req('/api/jobs/analyze')))).toBe(true);
  });

  it('denies when the secret is not configured', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    expect((await proxy(req('/api/analyze'))).status).toBe(503);
  });
});
