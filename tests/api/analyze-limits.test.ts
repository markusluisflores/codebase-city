import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAnalyze, runLiveJob, type AnalyzeDeps } from '@/lib/api/analyze';
import { putCached } from '@/lib/db/cache';
import { setDb } from '@/lib/db/client';
import { createOrReuseJob, setJobPhase } from '@/lib/db/jobs';
import {
  ANALYSIS_LIMIT_PER_IP_DAY,
  DAILY_LIMIT,
  ipLimitKey,
  LOOKUP_LIMIT_PER_IP_HOUR,
} from '@/lib/db/limits';
import { errorMessage } from '@/lib/errors';
import { GitHubError } from '@/lib/repo/github';
import { pgAdapter, useTestDb } from '../helpers/pgliteDb';
import { sampleAnalysis } from '../helpers/sampleAnalysis';
import { cookie, facts, fakeSandbox, SECRET, SHA, stubSessionEnv } from '../helpers/flowHelpers';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(async () => {
  await t.reset();
  setDb(pgAdapter(t.pg));
  stubSessionEnv();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const NOW = new Date('2026-11-16T12:00:00Z');
const IP = '203.0.113.9';
const KEY = () => ipLimitKey(SECRET, IP);

const post = async (repo: string, ip: string | null = IP) =>
  new Request('http://localhost/api/analyze', {
    method: 'POST',
    body: JSON.stringify({ repo }),
    headers: {
      'content-type': 'application/json',
      cookie: await cookie(),
      ...(ip ? { 'x-vercel-forwarded-for': ip } : {}),
    },
  });

function harness(over: Partial<AnalyzeDeps> = {}) {
  const work: (() => Promise<void>)[] = [];
  const fetchFacts = vi.fn(async (o: string, n: string) => facts({ owner: o, name: n }));
  const sb = fakeSandbox();
  return {
    work,
    fetchFacts,
    sb,
    deps: {
      fetchFacts,
      gallery: async () => null,
      sandbox: sb.deps,
      schedule: (w: () => Promise<void>) => void work.push(w),
      now: () => NOW,
      ...over,
    } satisfies AnalyzeDeps,
  };
}

async function count(period: string): Promise<number> {
  return (
    (
      await t.pg.query<{ count: number }>('SELECT count FROM usage_counters WHERE period = $1', [
        period,
      ])
    ).rows[0]?.count ?? 0
  );
}
const analyses = () => count(`an:2026-11-16:ip:${KEY()}`);
const lookups = () => count(`lk:2026-11-16T12:ip:${KEY()}`);

describe('lookup limit (before any GitHub call)', () => {
  it('refuses the over-limit request with 429, the fixed message and a retry-after, before GitHub', async () => {
    const h = harness();
    h.fetchFacts.mockRejectedValue(new GitHubError('not_found')); // each lookup spends GitHub calls, none starts a job
    for (let i = 0; i < LOOKUP_LIMIT_PER_IP_HOUR; i++) {
      expect((await handleAnalyze(await post(`o/r${i}`), h.deps)).status).toBe(404);
    }
    const before = h.fetchFacts.mock.calls.length;
    const res = await handleAnalyze(await post('o/another'), h.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(60 * 60));
    expect(await res.json()).toEqual({
      error: 'lookup_limit',
      message: errorMessage('lookup_limit'),
    });
    expect(h.fetchFacts.mock.calls.length).toBe(before); // no GitHub call
  });

  it('counts a cached result as a lookup (it cost GitHub calls) but never as an analysis', async () => {
    await putCached(sampleAnalysis('Octo', 'Repo', SHA), NOW);
    const h = harness();
    const res = await handleAnalyze(await post('octo/repo'), h.deps);
    expect(await res.json()).toMatchObject({ status: 'cached', source: 'live' });
    expect(await lookups()).toBe(1);
    expect(await analyses()).toBe(0);
    expect(await count('d:2026-11-16')).toBe(0);
  });

  it('a gallery repo costs nothing: no lookup, no analysis, no GitHub', async () => {
    const h = harness({ gallery: async () => sampleAnalysis('Octo', 'Repo', SHA) });
    for (let i = 0; i < LOOKUP_LIMIT_PER_IP_HOUR + 5; i++) {
      const res = await handleAnalyze(await post('octo/repo'), h.deps);
      expect((await res.json()).source).toBe('gallery');
    }
    expect(h.fetchFacts).not.toHaveBeenCalled();
    expect((await t.pg.query('SELECT 1 FROM usage_counters')).rows).toHaveLength(0);
  });

  it('invalid input is refused before any counter is touched', async () => {
    const h = harness();
    await handleAnalyze(await post('not a repo'), h.deps);
    expect((await t.pg.query('SELECT 1 FROM usage_counters')).rows).toHaveLength(0);
  });

  it('fails closed (503, no GitHub call) when the limiter cannot be reached', async () => {
    const h = harness();
    setDb({
      async query() {
        throw new Error('connection refused: postgres://user:secret@host');
      },
    });
    const res = await handleAnalyze(await post('o/r'), h.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('db_unavailable');
    expect(h.fetchFacts).not.toHaveBeenCalled();
  });

  it('buckets a request with no client-IP header together, not unlimited', async () => {
    const h = harness();
    h.fetchFacts.mockRejectedValue(new GitHubError('not_found'));
    for (let i = 0; i < LOOKUP_LIMIT_PER_IP_HOUR; i++)
      await handleAnalyze(await post(`o/r${i}`, null), h.deps);
    const res = await handleAnalyze(await post('o/x', null), h.deps);
    expect((await res.json()).error).toBe('lookup_limit');
  });
});

describe('per-IP daily analysis limit', () => {
  it('allows the limit, then refuses with 429 analysis_limit and a retry-after to UTC midnight, starting nothing', async () => {
    const h = harness();
    for (let i = 0; i < ANALYSIS_LIMIT_PER_IP_DAY; i++) {
      const res = await handleAnalyze(await post(`o/r${i}`), h.deps);
      const body = await res.json();
      expect(body).toMatchObject({
        status: 'job',
        analysesLeft: ANALYSIS_LIMIT_PER_IP_DAY - i - 1,
      });
    }
    expect(h.work).toHaveLength(ANALYSIS_LIMIT_PER_IP_DAY);
    const res = await handleAnalyze(await post('o/over'), h.deps);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(12 * 3600));
    expect(await res.json()).toEqual({
      error: 'analysis_limit',
      message: errorMessage('analysis_limit'),
    });
    expect(h.work).toHaveLength(ANALYSIS_LIMIT_PER_IP_DAY); // nothing scheduled
    expect(await count('d:2026-11-16')).toBe(ANALYSIS_LIMIT_PER_IP_DAY); // no global unit taken
    expect(await analyses()).toBe(ANALYSIS_LIMIT_PER_IP_DAY);
  });

  it('another IP is unaffected', async () => {
    const h = harness();
    for (let i = 0; i < ANALYSIS_LIMIT_PER_IP_DAY; i++)
      await handleAnalyze(await post(`o/r${i}`), h.deps);
    const res = await handleAnalyze(await post('o/other', '198.51.100.7'), h.deps);
    expect((await res.json()).status).toBe('job');
  });

  it('reusing a job in flight takes no analysis unit', async () => {
    const h = harness();
    const first = await (await handleAnalyze(await post('o/r'), h.deps)).json();
    const second = await (await handleAnalyze(await post('o/r', '198.51.100.7'), h.deps)).json();
    expect(second).toEqual({ status: 'job', id: first.id });
    expect(await analyses()).toBe(1);
  });

  it('concurrent first requests from one IP cannot start more than the limit', async () => {
    const h = harness();
    const results = await Promise.all(
      Array.from({ length: ANALYSIS_LIMIT_PER_IP_DAY * 2 }, async (_v, i) =>
        handleAnalyze(await post(`o/c${i}`), h.deps),
      ),
    );
    // Lookups are 20 an hour, so all 10 get through to the job step; only 5 may start.
    expect(results.filter((r) => r.status === 200)).toHaveLength(ANALYSIS_LIMIT_PER_IP_DAY);
    expect(h.work).toHaveLength(ANALYSIS_LIMIT_PER_IP_DAY);
    expect(await analyses()).toBe(ANALYSIS_LIMIT_PER_IP_DAY);
  });

  it('the global daily cap still applies and gives the per-IP unit back when it refuses', async () => {
    await t.pg.query(`INSERT INTO usage_counters (period, count) VALUES ('d:2026-11-16', $1)`, [
      DAILY_LIMIT,
    ]);
    const h = harness();
    const res = await handleAnalyze(await post('o/r'), h.deps);
    expect((await res.json()).error).toBe('daily');
    expect(await analyses()).toBe(0);
  });

  it('a failure before the Sandbox exists refunds the per-IP unit with the global one', async () => {
    const sb = fakeSandbox({ createFails: true });
    const h = harness({ sandbox: sb.deps });
    await handleAnalyze(await post('o/r'), h.deps);
    expect(await analyses()).toBe(1);
    for (const w of h.work.splice(0)) await w();
    expect(await analyses()).toBe(0);
    expect(await count('d:2026-11-16')).toBe(0);
  });

  it('a failure after the Sandbox exists keeps both units', async () => {
    const sb = fakeSandbox({ exitCode: 1 });
    const h = harness({ sandbox: sb.deps });
    await handleAnalyze(await post('o/r'), h.deps);
    for (const w of h.work.splice(0)) await w();
    expect(sb.created.length).toBeGreaterThan(0);
    expect(await analyses()).toBe(1);
    expect(await count('d:2026-11-16')).toBe(1);
  });

  it('failing a job that holds a per-IP unit before its Sandbox exists gives the unit back', async () => {
    const { id } = await createOrReuseJob('o', 'r', NOW, KEY());
    await setJobPhase(id, 'failed', 'internal_error');
    expect(await analyses()).toBe(0);
  });

  it('refunds against the reservation day, not the day of the release', async () => {
    const { id } = await createOrReuseJob('o', 'r', NOW, KEY());
    expect(await analyses()).toBe(1);
    // The release happens a day later: the unit still goes back to the day it was taken on.
    vi.useFakeTimers({ now: new Date('2026-11-17T00:10:00Z'), toFake: ['Date'] });
    try {
      await setJobPhase(id, 'failed', 'clone_failed');
    } finally {
      vi.useRealTimers();
    }
    expect(await analyses()).toBe(0);
  });
});

describe('fail safe when the migration has not been run', () => {
  it('without jobs.ip_key live analysis fails closed (503) and starts no Sandbox', async () => {
    await t.pg.exec('ALTER TABLE jobs DROP COLUMN ip_key');
    try {
      const h = harness();
      const res = await handleAnalyze(await post('o/r'), h.deps);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('db_unavailable');
      expect(h.work).toHaveLength(0);
      expect(h.sb.created).toHaveLength(0);
      expect(await count('d:2026-11-16')).toBe(0); // no global unit taken either
    } finally {
      await t.pg.exec('ALTER TABLE jobs ADD COLUMN ip_key text');
    }
  });
});

describe('behaviour below the limit is unchanged', () => {
  it('a normal analysis runs to done with the same response shape plus analysesLeft', async () => {
    const h = harness();
    const res = await handleAnalyze(await post('o/r'), h.deps);
    expect(await res.json()).toEqual({
      status: 'job',
      id: expect.any(String),
      analysesLeft: ANALYSIS_LIMIT_PER_IP_DAY - 1,
    });
    expect(h.work).toHaveLength(1);
    void runLiveJob; // imported for parity with analyze.test.ts
  });
});
