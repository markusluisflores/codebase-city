// Stateless HMAC sessions, a deliberate copy of the-fourth-official/lib/session.ts with extra checks.
// Web Crypto only, so it runs in the proxy and in Node route handlers. Secrets are parameters
// (callers read the environment), and nothing here logs or echoes a secret, password or IP.

import { errorMessage, errorStatus, type ErrorCode } from '@/lib/errors';

// "__Host-" makes browsers require Secure + Path=/ + no Domain, so a sibling subdomain cannot plant a cookie.
export const SESSION_COOKIE = '__Host-cc_session';
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days
export const MIN_PASSWORD_LENGTH = 16;
export const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

// Domain separation: SESSION_SECRET also keys password comparisons and (Task 12a) login-IP hashes,
// so each use prefixes the message and a signature from one domain never verifies in another.
const SESSION_DOMAIN = 'session:';
const PASSWORD_DOMAIN = 'pw:';

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
  let bin = '';
  for (const byte of sig) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Constant-time compare. Every call site compares two HMAC outputs of fixed length, so the length
// check leaks nothing about the secret.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const payload = String(now);
  return `${payload}.${await hmac(secret, SESSION_DOMAIN + payload)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token || token.length > 128) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const payload = parts[0] ?? '';
  const sig = parts[1] ?? '';
  if (!/^\d{1,16}$/.test(payload) || sig.length === 0) return false;
  // Verify the signature before looking at the time, so the answer does not depend on the payload's value.
  if (!timingSafeEqual(sig, await hmac(secret, SESSION_DOMAIN + payload))) return false;
  const ageMs = now - Number(payload);
  const clockSkewMs = 60_000;
  return ageMs < SESSION_MAX_AGE_S * 1000 && ageMs > -clockSkewMs;
}

// HMAC both sides, then compare in constant time: neither the timing nor the length of the real
// password reaches the caller.
export async function passwordMatches(
  secret: string,
  submitted: string,
  actual: string,
): Promise<boolean> {
  return timingSafeEqual(
    await hmac(secret, PASSWORD_DOMAIN + submitted),
    await hmac(secret, PASSWORD_DOMAIN + actual),
  );
}

/** Throws unless DEMO_PASSWORD is at least 16 characters and SESSION_SECRET is at least 32. Messages name the variable only. */
export function assertSessionConfig(env: Record<string, string | undefined>): {
  demoPassword: string;
  secret: string;
} {
  const demoPassword = env.DEMO_PASSWORD;
  const secret = env.SESSION_SECRET;
  if (!demoPassword || demoPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`DEMO_PASSWORD must be set and at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`);
  }
  return { demoPassword, secret };
}

const NO_STORE = { 'cache-control': 'no-store' };

/** Same body shape as the API errors (`{error, message}`), with the code's fixed message and status. */
function jsonError(code: ErrorCode, extra: Record<string, string> = {}): Response {
  return Response.json(
    { error: code, message: errorMessage(code) },
    { status: errorStatus(code), headers: { ...NO_STORE, ...extra } },
  );
}
export { jsonError };

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Authorization check for gated handlers: null when the request carries a valid session, otherwise the
 * Response to return (401 for no or bad session, 503 when the server is misconfigured; both deny).
 */
export async function requireSession(
  req: Request,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<Response | null> {
  let secret: string;
  try {
    ({ secret } = assertSessionConfig(env));
  } catch {
    return jsonError('misconfigured');
  }
  const ok = await verifySessionToken(
    secret,
    readCookie(req.headers.get('cookie'), SESSION_COOKIE),
    now,
  );
  return ok ? null : jsonError('unauthorized');
}

/**
 * What the visitor's own cookie says, for the UI's locked/unlocked display (`GET /api/session`). Never
 * throws: a missing, forged, expired or unreadable cookie, or a misconfigured server, all read as locked.
 * `expiresAt` is derived from the signed issue time, so it matches what `verifySessionToken` enforces.
 */
export async function sessionStatus(
  req: Request,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): Promise<{ unlocked: false } | { unlocked: true; expiresAt: string }> {
  let secret: string;
  try {
    ({ secret } = assertSessionConfig(env));
  } catch {
    return { unlocked: false };
  }
  const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  if (!(await verifySessionToken(secret, token, now))) return { unlocked: false };
  const issuedAt = Number((token ?? '').split('.')[0]);
  return { unlocked: true, expiresAt: new Date(issuedAt + SESSION_MAX_AGE_S * 1000).toISOString() };
}

/** `Set-Cookie` value that removes the session cookie (same name, path and flags, expired now). */
export function clearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** `Set-Cookie` value for a new session: HttpOnly, Secure, SameSite=Lax, host-only, with an expiry. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

/** Post-login redirect target: a same-site absolute path or "/". Rejects URLs, `//host`, backslashes and control characters. */
export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  if (/%2f|%5c|%0[0-9a-f]|%1[0-9a-f]/i.test(next.split('?')[0] ?? '')) return '/';
  return next;
}

/**
 * Client IP for rate limiting. Only headers the platform sets are trusted: `x-vercel-forwarded-for`
 * (Vercel overwrites it) then `x-real-ip`. A client-supplied `x-forwarded-for` is ignored, so it cannot
 * be used to dodge the limit. No header means one shared "unknown" bucket (stricter, not looser).
 */
export function clientIp(headers: Headers): string {
  const raw = headers.get('x-vercel-forwarded-for') ?? headers.get('x-real-ip');
  const first = raw?.split(',')[0]?.trim();
  return first ? ipBucket(first.slice(0, 64)) : 'unknown';
}

// An IPv6 visitor normally controls a whole /64, so key on that prefix; otherwise rotating the low bits
// gives every guess a fresh bucket. IPv4 and anything unparseable is used as given.
function ipBucket(ip: string): string {
  const addr = ip.split('%')[0] ?? ip;
  if (!addr.includes(':') || addr.includes('.')) return ip;
  const [head, tail, extra] = addr.split('::');
  if (extra !== undefined) return ip;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups =
    tail === undefined ? left : [...left, ...Array<string>(Math.max(fill, 0)).fill('0'), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}
