import { createHmac } from 'node:crypto';
import type { LoginAttemptStore } from '@/lib/login-attempts';
import { getDb } from './client';

/** Starting values from the design (section 8): live analyses a day and a month, kept in Postgres. */
export const DAILY_LIMIT = 10;
export const MONTHLY_LIMIT = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC date of `now` as `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The counter keys (`d:YYYY-MM-DD`, `m:YYYY-MM`) for a UTC date. */
export function counterKeys(day: string): { day: string; month: string } {
  if (!DATE_RE.test(day)) throw new Error('invalid quota date');
  return { day: `d:${day}`, month: `m:${day.slice(0, 7)}` };
}

// One atomic statement per counter: the conditional upsert only increments while under the limit,
// and returns no row when the counter is already full.
const TAKE_UNIT = `
  INSERT INTO usage_counters (period, count) VALUES ($1, 1)
  ON CONFLICT (period) DO UPDATE SET count = usage_counters.count + 1
    WHERE usage_counters.count < $2
  RETURNING count`;

/**
 * Takes one unit of the daily and monthly quota for the UTC date of `now`. The daily counter is
 * checked first, so with both full the reason is `daily`. If the monthly counter refuses, the daily
 * unit just taken is given back.
 */
export async function reserveQuota(
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: 'daily' | 'monthly' }> {
  const db = getDb();
  const keys = counterKeys(utcDay(now));
  const daily = await db.query(TAKE_UNIT, [keys.day, DAILY_LIMIT]);
  if (daily.length === 0) return { ok: false, reason: 'daily' };
  const giveDailyBack = () =>
    db.query(`UPDATE usage_counters SET count = GREATEST(count - 1, 0) WHERE period = $1`, [
      keys.day,
    ]);
  let monthly: unknown[];
  try {
    monthly = await db.query(TAKE_UNIT, [keys.month, MONTHLY_LIMIT]);
  } catch (err) {
    // The daily unit is already taken: give it back so a failed monthly step cannot leak it.
    await giveDailyBack().catch(() => undefined);
    throw err;
  }
  if (monthly.length === 0) {
    await giveDailyBack();
    return { ok: false, reason: 'monthly' };
  }
  // Known gap, unfixable without a transaction: a process killed after this point but before the
  // caller marks the job reserved leaks one unit for that day.
  return { ok: true };
}

/**
 * Gives back one unit against the job's stored UTC reservation date (`YYYY-MM-DD`), not the time of
 * the release. Callers must make sure a job releases at most once: `jobs.ts` does this inside the
 * statement that moves the job to `failed`.
 */
export async function releaseQuota(reservedOn: string): Promise<void> {
  const keys = counterKeys(reservedOn);
  await getDb().query(
    `UPDATE usage_counters SET count = GREATEST(count - 1, 0) WHERE period IN ($1, $2)`,
    [keys.day, keys.month],
  );
}

// ---- Analyze limits (per IP and global), kept in `usage_counters` with fixed UTC windows. -------------
// The session cookie is a stateless timestamp that anyone with the password can mint again, so it cannot
// identify a holder; the limits key on the platform-set client IP (hashed) and on a global backstop.

/** GitHub lookups a UTC hour (each costs 3 GitHub API calls, cached results included). */
export const LOOKUP_LIMIT_PER_IP_HOUR = 20;
export const LOOKUP_LIMIT_GLOBAL_HOUR = 400;
/** New live analyses a UTC day for one client IP (the global daily cap stays 10). */
export const ANALYSIS_LIMIT_PER_IP_DAY = 5;

/** `HMAC(secret, "limit-ip:" + ip)` as hex: its own domain, so it never matches a login-attempt hash. */
export function ipLimitKey(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(`limit-ip:${ip}`).digest('hex');
}

/** Whole seconds until the next UTC hour (at least 1). */
export function secondsToNextHour(now: Date): number {
  const next = Math.floor(now.getTime() / 3_600_000 + 1) * 3_600_000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Whole seconds until the next UTC midnight (at least 1). */
export function secondsToNextUtcDay(now: Date): number {
  const next = Math.floor(now.getTime() / 86_400_000 + 1) * 86_400_000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

const hourStamp = (now: Date): string => now.toISOString().slice(0, 13); // 2026-11-16T12
const IP_KEY_RE = /^[0-9a-f]{64}$/;
const checkIpKey = (key: string): string => {
  if (!IP_KEY_RE.test(key)) throw new Error('invalid ip key');
  return key;
};

const GIVE_BACK = `UPDATE usage_counters SET count = GREATEST(count - 1, 0) WHERE period = $1`;

/**
 * Takes one GitHub lookup for this IP and one global one, for the UTC hour of `now`. The per-IP counter
 * is taken first; if the global ceiling then refuses, the per-IP unit goes back, so a refusal costs
 * nothing. Both increments are single conditional upserts (atomic under concurrency). Counters from past
 * hours are purged here. A throw means the caller must deny.
 */
export async function takeLookup(
  ipKey: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; retryAfterS: number }> {
  const db = getDb();
  const hour = hourStamp(now);
  const perIp = `lk:${hour}:ip:${checkIpKey(ipKey)}`;
  const global = `lk:${hour}:g`;
  const refused = { ok: false, retryAfterS: secondsToNextHour(now) } as const;
  await db
    .query(`DELETE FROM usage_counters WHERE period LIKE 'lk:%' AND period < $1`, [`lk:${hour}`])
    .catch(() => undefined);
  if ((await db.query(TAKE_UNIT, [perIp, LOOKUP_LIMIT_PER_IP_HOUR])).length === 0) return refused;
  let taken: unknown[];
  try {
    taken = await db.query(TAKE_UNIT, [global, LOOKUP_LIMIT_GLOBAL_HOUR]);
  } catch (err) {
    await db.query(GIVE_BACK, [perIp]).catch(() => undefined);
    throw err;
  }
  if (taken.length === 0) {
    await db.query(GIVE_BACK, [perIp]).catch(() => undefined);
    return refused;
  }
  return { ok: true };
}

/** The per-IP daily analysis counter key for a UTC date and a hashed IP. */
export function ipAnalysisPeriod(day: string, ipKey: string): string {
  if (!DATE_RE.test(day)) throw new Error('invalid quota date');
  return `an:${day}:ip:${checkIpKey(ipKey)}`;
}

/**
 * Takes one of this IP's live analyses for the UTC day of `now`, and says how many are left today.
 * Conditional upsert, atomic. Counters from earlier days are purged here. A throw means the caller must deny.
 */
export async function takeIpAnalysis(
  ipKey: string,
  now: Date,
): Promise<{ ok: true; left: number } | { ok: false; retryAfterS: number }> {
  const db = getDb();
  const day = utcDay(now);
  await db
    .query(`DELETE FROM usage_counters WHERE period LIKE 'an:%' AND period < $1`, [`an:${day}`])
    .catch(() => undefined);
  const rows = await db.query<{ count: number | string }>(TAKE_UNIT, [
    ipAnalysisPeriod(day, ipKey),
    ANALYSIS_LIMIT_PER_IP_DAY,
  ]);
  if (rows.length === 0) return { ok: false, retryAfterS: secondsToNextUtcDay(now) };
  return { ok: true, left: Math.max(ANALYSIS_LIMIT_PER_IP_DAY - Number(rows[0]?.count ?? 0), 0) };
}

/** Gives back one per-IP analysis against the reservation's own UTC date (not the time of the release). */
export async function releaseIpAnalysis(reservedOn: string, ipKey: string): Promise<void> {
  await getDb().query(GIVE_BACK, [ipAnalysisPeriod(reservedOn, ipKey)]);
}

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_RETENTION_MS = 60 * 60_000;
const LOGIN_MAX_PER_WINDOW = 5;

/** `HMAC(secret, "login-ip:" + ip)` as hex: domain-separated like the session module's HMACs. */
export function hashIp(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(`login-ip:${ip}`).digest('hex');
}

/**
 * The Postgres login-attempt store, following the contract in `lib/login-attempts.ts`: the raw IP
 * goes in and is hashed here; every attempt is recorded; the insert is committed before the count is
 * read (two separate statements, so a parallel burst cannot all read a low count); the count has no
 * upper time bound. Any throw means deny.
 */
export function createLoginAttemptStore(getSecret: () => string | undefined): LoginAttemptStore {
  const hashed = (ip: string): string => {
    const secret = getSecret();
    // The message names the variable only, never a value.
    if (!secret) throw new Error('SESSION_SECRET is not set');
    return hashIp(secret, ip);
  };
  return {
    async recordFailedLogin(ip, now) {
      const hash = hashed(ip);
      // One statement inserts this attempt and purges rows older than an hour. The count below is a
      // separate statement, which only runs after this one has committed.
      await getDb().query(
        `WITH purge AS (DELETE FROM login_attempts WHERE ts < $3 RETURNING 1)
         INSERT INTO login_attempts (ip_hash, ts) VALUES ($1, $2)`,
        [hash, now.toISOString(), new Date(now.getTime() - LOGIN_RETENTION_MS).toISOString()],
      );
    },
    async tooManyAttempts(ip, now) {
      const rows = await getDb().query<{ n: number | string }>(
        `SELECT count(*)::int AS n FROM login_attempts WHERE ip_hash = $1 AND ts > $2`,
        [hashed(ip), new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString()],
      );
      return Number(rows[0]?.n ?? 0) > LOGIN_MAX_PER_WINDOW;
    },
  };
}

/** The production store: the secret is `SESSION_SECRET`, read at call time. */
export const postgresLoginAttempts: LoginAttemptStore = createLoginAttemptStore(
  () => process.env.SESSION_SECRET,
);
