import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrReuseJob, getJob, setJobPhase } from '@/lib/db/jobs';
import { DAILY_LIMIT, MONTHLY_LIMIT, releaseQuota, reserveQuota } from '@/lib/db/limits';
import { setDb } from '@/lib/db/client';
import { pgAdapter, useTestDb } from '../helpers/pgliteDb';

// PGlite is one in-process connection, so statements are serialised: these tests prove statement-level
// interleaving and the SQL itself, not real row-lock waits across connections (see the task report).
let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(() => t.reset());

const NOON = new Date('2026-11-16T12:00:00Z');
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const MIN = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function counters(): Promise<Record<string, number>> {
  const r = await t.pg.query<{ period: string; count: number }>(
    'SELECT period, count FROM usage_counters',
  );
  return Object.fromEntries(r.rows.map((x) => [x.period, x.count]));
}

describe('quota', () => {
  it('refuses the 11th analysis in a day with daily', async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) expect(await reserveQuota(NOON)).toEqual({ ok: true });
    expect(await reserveQuota(NOON)).toEqual({ ok: false, reason: 'daily' });
  });

  it('refuses the 61st in a month with monthly, and gives the daily unit back', async () => {
    // 6 days x 10 = 60 units across one month.
    for (let d = 1; d <= 6; d++) {
      const day = new Date(Date.UTC(2026, 10, d, 12));
      for (let i = 0; i < DAILY_LIMIT; i++) expect(await reserveQuota(day)).toEqual({ ok: true });
    }
    const seventh = new Date(Date.UTC(2026, 10, 7, 12));
    expect(await reserveQuota(seventh)).toEqual({ ok: false, reason: 'monthly' });
    expect((await counters())['d:2026-11-07']).toBe(0);
    expect((await counters())['m:2026-11']).toBe(MONTHLY_LIMIT);
  });

  it('rolls the daily counter over at UTC midnight and the monthly one at month end', async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) await reserveQuota(new Date('2026-11-16T23:59:59Z'));
    expect(await reserveQuota(new Date('2026-11-16T23:59:59Z'))).toMatchObject({ ok: false });
    expect(await reserveQuota(new Date('2026-11-17T00:00:00Z'))).toEqual({ ok: true });

    for (let d = 1; d <= 6; d++) {
      for (let i = 0; i < DAILY_LIMIT; i++) await reserveQuota(new Date(Date.UTC(2026, 11, d, 1)));
    }
    expect(await reserveQuota(new Date('2026-12-07T01:00:00Z'))).toMatchObject({
      ok: false,
      reason: 'monthly',
    });
    expect(await reserveQuota(new Date('2027-01-01T00:00:00Z'))).toEqual({ ok: true });
  });

  it('does not let a release go below zero', async () => {
    await t.pg.query(
      `INSERT INTO usage_counters (period, count) VALUES ('d:2026-11-16', 0), ('m:2026-11', 0)`,
    );
    await releaseQuota('2026-11-16');
    expect(await counters()).toEqual({ 'd:2026-11-16': 0, 'm:2026-11': 0 });
  });

  it('gives the daily unit back when the monthly step throws', async () => {
    setDb({
      query: async (text, params) => {
        if (String(params?.[0]).startsWith('m:') && text.includes('INSERT INTO usage_counters')) {
          throw new Error('network');
        }
        return pgAdapter(t.pg).query(text, params);
      },
    });
    try {
      await expect(reserveQuota(NOON)).rejects.toThrow('network');
    } finally {
      setDb(pgAdapter(t.pg));
    }
    expect((await counters())['d:2026-11-16']).toBe(0);
  });

  it('rejects a malformed reservation date', async () => {
    await expect(releaseQuota("2026-11-16'; DROP TABLE jobs;--")).rejects.toThrow();
  });
});

describe('createOrReuseJob', () => {
  it('creates a UUID-id job, reserves one unit and marks it reserved', async () => {
    const { id, reused } = await createOrReuseJob('octo', 'repo', NOON);
    expect(reused).toBe(false);
    expect(id).toMatch(UUID);
    expect(await counters()).toEqual({ 'd:2026-11-16': 1, 'm:2026-11': 1 });
    const row = (await t.pg.query<{ reserved: boolean; reserved_on: string }>('SELECT * FROM jobs'))
      .rows[0];
    expect(row).toMatchObject({ reserved: true, reserved_on: '2026-11-16' });
    expect((await getJob(id, NOON))?.phase).toBe('queued');
  });

  it('reuses the in-flight job without reserving again', async () => {
    const first = await createOrReuseJob('octo', 'repo', NOON);
    const second = await createOrReuseJob('Octo', 'Repo', at(NOON, MIN));
    expect(second).toEqual({ id: first.id, reused: true });
    expect(await counters()).toEqual({ 'd:2026-11-16': 1, 'm:2026-11': 1 });
  });

  it('ten concurrent calls for one repo create one row and consume one unit', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => createOrReuseJob('octo', 'repo', NOON)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.reused)).toHaveLength(1);
    expect((await t.pg.query('SELECT 1 FROM jobs')).rows).toHaveLength(1);
    expect(await counters()).toEqual({ 'd:2026-11-16': 1, 'm:2026-11': 1 });
  });

  it('allows a new job for the repo once the previous one has finished', async () => {
    const a = await createOrReuseJob('octo', 'repo', NOON);
    await setJobPhase(a.id, 'done');
    const b = await createOrReuseJob('octo', 'repo', at(NOON, MIN));
    expect(b.reused).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it('leaves no reusable non-terminal row when the reservation is refused', async () => {
    for (let i = 0; i < DAILY_LIMIT; i++) await reserveQuota(NOON);
    const { id, reused } = await createOrReuseJob('octo', 'repo', NOON);
    expect(reused).toBe(false);
    expect(await getJob(id, NOON)).toMatchObject({ phase: 'failed', errorCode: 'daily' });
    const next = await createOrReuseJob('octo', 'repo', at(NOON, MIN));
    expect(next.id).not.toBe(id);
    expect((await counters())['d:2026-11-16']).toBe(DAILY_LIMIT);
  });

  it('a failed job releases its quota so the next analysis is allowed', async () => {
    for (let i = 0; i < DAILY_LIMIT - 1; i++) await reserveQuota(NOON);
    const job = await createOrReuseJob('octo', 'repo', NOON);
    expect((await counters())['d:2026-11-16']).toBe(DAILY_LIMIT);
    await setJobPhase(job.id, 'failed', 'clone_failed');
    expect((await counters())['d:2026-11-16']).toBe(DAILY_LIMIT - 1);
    expect(await reserveQuota(NOON)).toEqual({ ok: true });
  });

  it('releases the previous day for a job reserved at 23:59 UTC and failed after midnight', async () => {
    const start = new Date('2026-11-16T23:59:00Z');
    const job = await createOrReuseJob('octo', 'repo', start);
    await reserveQuota(new Date('2026-11-17T00:01:00Z'));
    await setJobPhase(job.id, 'failed', 'timeout');
    const c = await counters();
    expect(c['d:2026-11-16']).toBe(0);
    expect(c['d:2026-11-17']).toBe(1);
  });

  it('releases the quota exactly once however many callers fail the job', async () => {
    const job = await createOrReuseJob('octo', 'repo', NOON);
    await reserveQuota(NOON); // another job's unit, which must survive
    await Promise.all([
      setJobPhase(job.id, 'failed', 'a'),
      setJobPhase(job.id, 'failed', 'b'),
      getJob(job.id, at(NOON, 10 * MIN)),
    ]);
    await setJobPhase(job.id, 'failed', 'c');
    expect(await counters()).toEqual({ 'd:2026-11-16': 1, 'm:2026-11': 1 });
  });

  it('does not reopen or fail a done job', async () => {
    const job = await createOrReuseJob('octo', 'repo', NOON);
    await setJobPhase(job.id, 'done');
    await setJobPhase(job.id, 'failed', 'late');
    await setJobPhase(job.id, 'cloning');
    expect(await getJob(job.id, NOON)).toMatchObject({ phase: 'done', errorCode: null });
    expect((await counters())['d:2026-11-16']).toBe(1);
  });

  it('advances phases in order', async () => {
    const { id } = await createOrReuseJob('octo', 'repo', NOON);
    for (const phase of ['cloning', 'reading_history', 'computing', 'done'] as const) {
      await setJobPhase(id, phase);
      expect((await getJob(id, NOON))?.phase).toBe(phase);
    }
  });

  it('never moves a phase backwards', async () => {
    const { id } = await createOrReuseJob('octo', 'repo', NOON);
    await setJobPhase(id, 'computing');
    await setJobPhase(id, 'cloning');
    await setJobPhase(id, 'queued');
    expect((await getJob(id, NOON))?.phase).toBe('computing');
  });

  it('hands the unit back if the job is failed between the reservation and the reserved mark', async () => {
    setDb({
      query: async (text, params) => {
        if (text.startsWith('UPDATE jobs SET reserved = true')) {
          setDb(pgAdapter(t.pg));
          await setJobPhase(String(params?.[0]), 'failed', 'timeout'); // reserved is still false: releases nothing
        }
        return pgAdapter(t.pg).query(text, params);
      },
    });
    try {
      await createOrReuseJob('octo', 'repo', NOON);
    } finally {
      setDb(pgAdapter(t.pg));
    }
    expect((await counters())['d:2026-11-16']).toBe(0);
    expect((await counters())['m:2026-11']).toBe(0);
  });

  it('sweeps a stale row (6 minutes) for the repo: failed timeout, released, a new job is created', async () => {
    const old = await createOrReuseJob('octo', 'repo', NOON);
    const fresh = await createOrReuseJob('octo', 'repo', at(NOON, 6 * MIN));
    expect(fresh.reused).toBe(false);
    expect(fresh.id).not.toBe(old.id);
    expect(await getJob(old.id, at(NOON, 6 * MIN))).toMatchObject({
      phase: 'failed',
      errorCode: 'timeout',
    });
    // the old unit was released and the new job took one
    expect(await counters()).toEqual({ 'd:2026-11-16': 1, 'm:2026-11': 1 });
  });

  it('does not sweep a row that is 4:59 old', async () => {
    const a = await createOrReuseJob('octo', 'repo', NOON);
    const b = await createOrReuseJob('octo', 'repo', at(NOON, 5 * MIN - 1000));
    expect(b).toEqual({ id: a.id, reused: true });
  });

  it('sweeping a row that never reserved releases nothing', async () => {
    await t.pg.query(
      `INSERT INTO jobs (id, owner, name, phase, reserved, reserved_on, created_at)
       VALUES ('11111111-1111-4111-8111-111111111111','octo','repo','queued',false,'2026-11-16',$1)`,
      [NOON.toISOString()],
    );
    await reserveQuota(NOON); // someone else's unit
    await createOrReuseJob('octo', 'repo', at(NOON, 6 * MIN));
    // the sweep released nothing; the new job reserved one more
    expect((await counters())['d:2026-11-16']).toBe(2);
  });

  it('a different repo is unaffected by the sweep and gets its own job', async () => {
    const a = await createOrReuseJob('octo', 'one', NOON);
    const b = await createOrReuseJob('octo', 'two', at(NOON, 6 * MIN));
    expect(b.reused).toBe(false);
    expect((await getJob(a.id, NOON))?.phase).toBe('queued');
  });
});

describe('getJob', () => {
  it('reads a job 5:01 old as failed timeout and stores that, releasing its quota', async () => {
    const { id } = await createOrReuseJob('octo', 'repo', NOON);
    const job = await getJob(id, at(NOON, 5 * MIN + 1000));
    expect(job).toMatchObject({ phase: 'failed', errorCode: 'timeout' });
    expect((await t.pg.query<{ phase: string }>('SELECT phase FROM jobs')).rows[0]?.phase).toBe(
      'failed',
    );
    expect((await counters())['d:2026-11-16']).toBe(0);
  });

  it('does not time out a job at 4:59', async () => {
    const { id } = await createOrReuseJob('octo', 'repo', NOON);
    expect((await getJob(id, at(NOON, 5 * MIN - 1000)))?.phase).toBe('queued');
    expect((await counters())['d:2026-11-16']).toBe(1);
  });

  it('returns null for an unknown or malformed id without touching SQL', async () => {
    expect(await getJob('11111111-1111-4111-8111-111111111111', NOON)).toBeNull();
    expect(await getJob("x'; DROP TABLE jobs;--", NOON)).toBeNull();
  });
});

describe('createOrReuseJob failure paths', () => {
  it('fails the new row and returns the unit when marking it reserved throws', async () => {
    setDb({
      query: async (text, params) => {
        if (text.startsWith('UPDATE jobs SET reserved = true')) throw new Error('network');
        return pgAdapter(t.pg).query(text, params);
      },
    });
    try {
      await expect(createOrReuseJob('octo', 'repo', NOON)).rejects.toThrow('network');
    } finally {
      setDb(pgAdapter(t.pg));
    }
    expect(await counters()).toEqual({ 'd:2026-11-16': 0, 'm:2026-11': 0 });
    const next = await createOrReuseJob('octo', 'repo', NOON);
    expect(next.reused).toBe(false);
  });
});
