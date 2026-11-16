import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertSessionConfig,
  clientIp,
  createSessionToken,
  passwordMatches,
  safeNextPath,
  SESSION_MAX_AGE_S,
  verifySessionToken,
} from '@/lib/session';

// Fake values created here; they are not real credentials.
const SECRET = 'test-secret-at-least-32-chars-long!!';
const OTHER = 'other-secret-also-32-chars-long!!!!';

describe('session tokens', () => {
  it('round-trips a fresh token', async () => {
    expect(await verifySessionToken(SECRET, await createSessionToken(SECRET))).toBe(true);
  });

  it('rejects a token signed with another secret', async () => {
    expect(await verifySessionToken(SECRET, await createSessionToken(OTHER))).toBe(false);
  });

  it('rejects a tampered payload and a tampered signature', async () => {
    const token = await createSessionToken(SECRET, 1_000_000);
    const sig = token.split('.')[1] ?? '';
    expect(await verifySessionToken(SECRET, `1000001.${sig}`, 1_000_000)).toBe(false);
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(await verifySessionToken(SECRET, `1000000.${flipped}`, 1_000_000)).toBe(false);
  });

  it('rejects missing, empty, unsigned, malformed and oversized values', async () => {
    for (const bad of [
      undefined,
      '',
      'no-dot',
      '.sig',
      '123.',
      '123.sig.extra',
      'abc.def',
      'x'.repeat(5000),
    ]) {
      expect(await verifySessionToken(SECRET, bad)).toBe(false);
    }
  });

  it('rejects non-decimal payloads even when correctly signed', async () => {
    // Sign a payload such as "1e3" or " 5" with the real key: shape check must still refuse it.
    const real = await createSessionToken(SECRET, 5);
    const sig = real.split('.')[1];
    expect(await verifySessionToken(SECRET, `1e3.${sig}`)).toBe(false);
    expect(await verifySessionToken(SECRET, `-5.${sig}`)).toBe(false);
  });

  it('rejects an expired token and accepts one just inside the lifetime', async () => {
    const issued = 10_000_000;
    const token = await createSessionToken(SECRET, issued);
    expect(await verifySessionToken(SECRET, token, issued + SESSION_MAX_AGE_S * 1000 - 1)).toBe(
      true,
    );
    expect(await verifySessionToken(SECRET, token, issued + SESSION_MAX_AGE_S * 1000)).toBe(false);
  });

  it('rejects a token issued in the future', async () => {
    const now = 10_000_000;
    expect(
      await verifySessionToken(SECRET, await createSessionToken(SECRET, now + 10 * 60_000), now),
    ).toBe(false);
  });

  it('keeps the payload minimal: only the issue time and the signature', async () => {
    const token = await createSessionToken(SECRET, 1234);
    expect(token).toMatch(/^1234\.[A-Za-z0-9_-]{43}$/);
  });

  it('does not accept signatures from another HMAC domain (domain separation)', async () => {
    const sign = (data: string) => createHmac('sha256', SECRET).update(data).digest('base64url');
    expect(await verifySessionToken(SECRET, `5.${sign('session:5')}`, 5)).toBe(true); // control
    expect(await verifySessionToken(SECRET, `5.${sign('5')}`, 5)).toBe(false);
    expect(await verifySessionToken(SECRET, `5.${sign('pw:5')}`, 5)).toBe(false);
    expect(await verifySessionToken(SECRET, `5.${sign('login-ip:5')}`, 5)).toBe(false);
  });
});

describe('passwordMatches', () => {
  it('accepts the right password and refuses wrong, near and different-length ones', async () => {
    expect(await passwordMatches(SECRET, 'a-fake-demo-pass-1234', 'a-fake-demo-pass-1234')).toBe(
      true,
    );
    expect(await passwordMatches(SECRET, 'a-fake-demo-pass-1235', 'a-fake-demo-pass-1234')).toBe(
      false,
    );
    expect(await passwordMatches(SECRET, 'A-FAKE-DEMO-PASS-1234', 'a-fake-demo-pass-1234')).toBe(
      false,
    );
    expect(await passwordMatches(SECRET, 'a-fake', 'a-fake-demo-pass-1234')).toBe(false);
    expect(await passwordMatches(SECRET, '', 'a-fake-demo-pass-1234')).toBe(false);
  });
});

describe('assertSessionConfig', () => {
  const pw16 = 'p'.repeat(16);
  it('throws for a 15-character DEMO_PASSWORD', () => {
    expect(() =>
      assertSessionConfig({ DEMO_PASSWORD: 'p'.repeat(15), SESSION_SECRET: SECRET }),
    ).toThrow(/DEMO_PASSWORD/);
  });
  it('throws for a missing or empty SESSION_SECRET, and for a missing DEMO_PASSWORD', () => {
    expect(() => assertSessionConfig({ DEMO_PASSWORD: pw16 })).toThrow(/SESSION_SECRET/);
    expect(() => assertSessionConfig({ DEMO_PASSWORD: pw16, SESSION_SECRET: '' })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => assertSessionConfig({ SESSION_SECRET: SECRET })).toThrow(/DEMO_PASSWORD/);
  });
  it('throws for a SESSION_SECRET shorter than 32 characters', () => {
    expect(() =>
      assertSessionConfig({ DEMO_PASSWORD: pw16, SESSION_SECRET: 's'.repeat(31) }),
    ).toThrow(/SESSION_SECRET/);
  });
  it('passes for 16 characters and returns the values', () => {
    expect(assertSessionConfig({ DEMO_PASSWORD: pw16, SESSION_SECRET: SECRET })).toEqual({
      demoPassword: pw16,
      secret: SECRET,
    });
  });
  it('never puts either value in the error message', () => {
    const secretish = 'short-secret-value';
    try {
      assertSessionConfig({ DEMO_PASSWORD: 'tooshort-pass', SESSION_SECRET: secretish });
    } catch (e) {
      expect(String(e)).not.toContain('tooshort-pass');
      expect(String(e)).not.toContain(secretish);
    }
  });
});

describe('safeNextPath (no open redirect)', () => {
  it('allows same-site absolute paths only', () => {
    expect(safeNextPath('/r/vercel/next.js')).toBe('/r/vercel/next.js');
    expect(safeNextPath('/?q=1')).toBe('/?q=1');
  });
  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'evil.example',
    '/%2F%2Fevil.example',
    '/\t/evil.example',
    '/a\nb',
    '',
    null,
    undefined,
  ])('falls back to / for %j', (v) => {
    expect(safeNextPath(v as string | null | undefined)).toBe('/');
  });
});

describe('clientIp', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('prefers the platform header the visitor cannot set', () => {
    expect(
      clientIp(h({ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' })),
    ).toBe('203.0.113.9');
  });
  it('falls back to x-real-ip, then to a shared bucket', () => {
    expect(clientIp(h({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(h({}))).toBe('unknown');
  });
  it('ignores a client-supplied x-forwarded-for chain entirely', () => {
    expect(clientIp(h({ 'x-forwarded-for': '9.9.9.9' }))).toBe('unknown');
  });
  it('bounds the length of the value', () => {
    expect(clientIp(h({ 'x-real-ip': 'a'.repeat(500) })).length).toBeLessThanOrEqual(64);
  });
});
