import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLoginAttemptStore } from '@/lib/db/limits';
import { useTestDb } from '../helpers/pgliteDb';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(() => t.reset());

const SECRET = 'test-secret-that-is-long-enough-for-hmac-1234';
const store = createLoginAttemptStore(() => SECRET);
const NOW = new Date('2026-11-16T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('login attempt store', () => {
  it('blocks from the 6th attempt in a minute, not before', async () => {
    for (let i = 1; i <= 6; i++) {
      await store.recordFailedLogin('203.0.113.9', at(i * 1000));
      expect(await store.tooManyAttempts('203.0.113.9', at(i * 1000))).toBe(i > 5);
    }
  });

  it('allows an attempt once the one-minute window has passed, and leaves other IPs alone', async () => {
    for (let i = 0; i < 6; i++) await store.recordFailedLogin('203.0.113.9', NOW);
    expect(await store.tooManyAttempts('203.0.113.9', at(59_000))).toBe(true);
    expect(await store.tooManyAttempts('203.0.113.9', at(60_001))).toBe(false);
    expect(await store.tooManyAttempts('203.0.113.10', NOW)).toBe(false);
  });

  it('counts rows without an upper time bound (an instance clock running ahead)', async () => {
    for (let i = 0; i < 6; i++) await store.recordFailedLogin('203.0.113.9', at(30_000));
    expect(await store.tooManyAttempts('203.0.113.9', NOW)).toBe(true);
  });

  it('stores only the domain-separated HMAC, never the raw IP', async () => {
    await store.recordFailedLogin('203.0.113.9', NOW);
    const dump = JSON.stringify((await t.pg.query('SELECT * FROM login_attempts')).rows);
    expect(dump).not.toContain('203.0.113.9');
    const stored = (await t.pg.query<{ ip_hash: string }>('SELECT ip_hash FROM login_attempts'))
      .rows[0]?.ip_hash;
    expect(stored).toBe(createHmac('sha256', SECRET).update('login-ip:203.0.113.9').digest('hex'));
    expect(stored).not.toBe(createHmac('sha256', SECRET).update('203.0.113.9').digest('hex'));
  });

  it('purges rows older than an hour on the next insert', async () => {
    await store.recordFailedLogin('198.51.100.1', NOW);
    await store.recordFailedLogin('198.51.100.2', at(59 * 60_000));
    expect((await t.pg.query('SELECT 1 FROM login_attempts')).rows).toHaveLength(2);
    await store.recordFailedLogin('198.51.100.3', at(61 * 60_000));
    const left = (await t.pg.query('SELECT 1 FROM login_attempts')).rows;
    expect(left).toHaveLength(2); // the 61-minute-old row is gone
  });

  it('fails closed when the secret is missing, without echoing anything', async () => {
    const broken = createLoginAttemptStore(() => undefined);
    await expect(broken.recordFailedLogin('203.0.113.9', NOW)).rejects.toThrow(
      'SESSION_SECRET is not set',
    );
    await expect(broken.tooManyAttempts('203.0.113.9', NOW)).rejects.toThrow();
  });

  it('cannot be raced: of 40 parallel attempts from one IP, at most 5 get compared', async () => {
    // Mirrors handleLogin: record the attempt, then check, and only compare when not blocked.
    const compared = await Promise.all(
      Array.from({ length: 40 }, async () => {
        await store.recordFailedLogin('203.0.113.9', NOW);
        return !(await store.tooManyAttempts('203.0.113.9', NOW));
      }),
    );
    expect(compared.filter(Boolean).length).toBeLessThanOrEqual(5);
  });

  it('keeps parallel IPs independent under load', async () => {
    const results = await Promise.all(
      ['a', 'b'].flatMap((ip) =>
        Array.from({ length: 10 }, async () => {
          await store.recordFailedLogin(ip, NOW);
          return { ip, ok: !(await store.tooManyAttempts(ip, NOW)) };
        }),
      ),
    );
    for (const ip of ['a', 'b']) {
      expect(results.filter((r) => r.ip === ip && r.ok).length).toBeLessThanOrEqual(5);
    }
  });
});
