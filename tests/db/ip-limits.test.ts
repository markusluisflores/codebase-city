import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANALYSIS_LIMIT_PER_IP_DAY,
  LOOKUP_LIMIT_GLOBAL_HOUR,
  LOOKUP_LIMIT_PER_IP_HOUR,
  ipLimitKey,
  secondsToNextHour,
  secondsToNextUtcDay,
  takeIpAnalysis,
  takeLookup,
} from '@/lib/db/limits';
import { useTestDb } from '../helpers/pgliteDb';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(() => t.reset());

const NOW = new Date('2026-11-16T12:30:00Z');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

async function count(period: string): Promise<number | undefined> {
  return (
    await t.pg.query<{ count: number }>('SELECT count FROM usage_counters WHERE period = $1', [
      period,
    ])
  ).rows[0]?.count;
}

describe('ipLimitKey', () => {
  it('is a domain-separated HMAC, never the raw IP and not the login hash', () => {
    const k = ipLimitKey('s'.repeat(40), '203.0.113.9');
    expect(k).toBe(
      createHmac('sha256', 's'.repeat(40)).update('limit-ip:203.0.113.9').digest('hex'),
    );
    expect(k).not.toContain('203.0.113.9');
    expect(k).not.toBe(
      createHmac('sha256', 's'.repeat(40)).update('login-ip:203.0.113.9').digest('hex'),
    );
  });
});

describe('retry hints', () => {
  it('counts down to the next UTC hour and the next UTC midnight, at least 1 second', () => {
    expect(secondsToNextHour(NOW)).toBe(30 * 60);
    expect(secondsToNextHour(new Date('2026-11-16T12:59:59.500Z'))).toBe(1);
    expect(secondsToNextUtcDay(NOW)).toBe(11.5 * 3600);
    expect(secondsToNextUtcDay(new Date('2026-11-16T23:59:59.900Z'))).toBe(1);
  });
});

describe('takeLookup', () => {
  it('allows the per-IP limit, refuses the next with a retry hint, and leaves other IPs alone', async () => {
    for (let i = 0; i < LOOKUP_LIMIT_PER_IP_HOUR; i++) {
      expect(await takeLookup(A, NOW)).toEqual({ ok: true });
    }
    expect(await takeLookup(A, NOW)).toEqual({ ok: false, retryAfterS: 30 * 60 });
    expect(await takeLookup(B, NOW)).toEqual({ ok: true });
  });

  it('a refused request does not consume a global unit', async () => {
    for (let i = 0; i < LOOKUP_LIMIT_PER_IP_HOUR; i++) await takeLookup(A, NOW);
    await takeLookup(A, NOW);
    await takeLookup(A, NOW);
    expect(await count('lk:2026-11-16T12:g')).toBe(LOOKUP_LIMIT_PER_IP_HOUR);
  });

  it('refuses everyone at the global hourly ceiling and creates no per-IP row', async () => {
    await t.pg.query(
      `INSERT INTO usage_counters (period, count) VALUES ('lk:2026-11-16T12:g', $1)`,
      [LOOKUP_LIMIT_GLOBAL_HOUR],
    );
    expect(await takeLookup(A, NOW)).toEqual({ ok: false, retryAfterS: 30 * 60 });
    expect(await count(`lk:2026-11-16T12:ip:${A}`)).toBeUndefined(); // table growth stays bounded
  });

  it('starts fresh in the next UTC hour', async () => {
    for (let i = 0; i < LOOKUP_LIMIT_PER_IP_HOUR; i++) await takeLookup(A, NOW);
    expect((await takeLookup(A, NOW)).ok).toBe(false);
    expect(await takeLookup(A, new Date('2026-11-16T13:00:00Z'))).toEqual({ ok: true });
  });

  it('concurrent requests cannot exceed the limit (atomic increment)', async () => {
    const results = await Promise.all(
      Array.from({ length: LOOKUP_LIMIT_PER_IP_HOUR * 3 }, () => takeLookup(A, NOW)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(LOOKUP_LIMIT_PER_IP_HOUR);
    expect(await count(`lk:2026-11-16T12:ip:${A}`)).toBe(LOOKUP_LIMIT_PER_IP_HOUR);
    expect(await count('lk:2026-11-16T12:g')).toBe(LOOKUP_LIMIT_PER_IP_HOUR);
  });

  it('purges counters from past hours and keeps the current one and unrelated keys', async () => {
    await t.pg.query(
      `INSERT INTO usage_counters (period, count) VALUES
         ('lk:2026-11-16T09:g', 3), ('lk:2026-11-16T09:ip:${A}', 3), ('d:2026-11-16', 4)`,
    );
    await takeLookup(A, NOW);
    expect(await count('lk:2026-11-16T09:g')).toBeUndefined();
    expect(await count(`lk:2026-11-16T09:ip:${A}`)).toBeUndefined();
    expect(await count('d:2026-11-16')).toBe(4);
    expect(await count('lk:2026-11-16T12:g')).toBe(1);
  });

  it('stores only the hashed key, never anything shaped like a raw IP', async () => {
    await takeLookup(A, NOW);
    const dump = JSON.stringify((await t.pg.query('SELECT * FROM usage_counters')).rows);
    expect(dump).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
});

describe('takeIpAnalysis', () => {
  it('allows the daily limit, reports how many are left, then refuses until UTC midnight', async () => {
    for (let i = 1; i <= ANALYSIS_LIMIT_PER_IP_DAY; i++) {
      expect(await takeIpAnalysis(A, NOW)).toEqual({
        ok: true,
        left: ANALYSIS_LIMIT_PER_IP_DAY - i,
      });
    }
    expect(await takeIpAnalysis(A, NOW)).toEqual({ ok: false, retryAfterS: 11.5 * 3600 });
    expect(await takeIpAnalysis(B, NOW)).toMatchObject({ ok: true });
    expect(await count(`an:2026-11-16:ip:${A}`)).toBe(ANALYSIS_LIMIT_PER_IP_DAY);
  });

  it('resets on the next UTC day', async () => {
    for (let i = 0; i < ANALYSIS_LIMIT_PER_IP_DAY; i++) await takeIpAnalysis(A, NOW);
    expect((await takeIpAnalysis(A, NOW)).ok).toBe(false);
    expect((await takeIpAnalysis(A, new Date('2026-11-17T00:00:00Z'))).ok).toBe(true);
  });

  it('concurrent requests cannot exceed the limit (atomic increment)', async () => {
    const results = await Promise.all(
      Array.from({ length: ANALYSIS_LIMIT_PER_IP_DAY * 3 }, () => takeIpAnalysis(A, NOW)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(ANALYSIS_LIMIT_PER_IP_DAY);
  });

  it('purges counters from earlier days', async () => {
    await t.pg.query(
      `INSERT INTO usage_counters (period, count) VALUES ('an:2026-11-14:ip:${A}', 2)`,
    );
    await takeIpAnalysis(A, NOW);
    expect(await count(`an:2026-11-14:ip:${A}`)).toBeUndefined();
  });
});
