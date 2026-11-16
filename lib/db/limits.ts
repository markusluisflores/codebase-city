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

export const recordFailedLogin = postgresLoginAttempts.recordFailedLogin;
export const tooManyAttempts = postgresLoginAttempts.tooManyAttempts;
