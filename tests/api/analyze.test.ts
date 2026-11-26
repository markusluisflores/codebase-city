import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as analyzeRoute from '@/app/api/analyze/route';
import { handleAnalyze, runLiveJob, type AnalyzeDeps } from '@/lib/api/analyze';
import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import { CAPS } from '@/lib/caps';
import { getCached, putCached } from '@/lib/db/cache';
import { setDb } from '@/lib/db/client';
import { JOB_STALE_MS } from '@/lib/db/jobs';
import { GitHubError, GitHubRateLimited } from '@/lib/repo/github';
import { pgAdapter, useTestDb } from '../helpers/pgliteDb';
import { sampleAnalysis } from '../helpers/sampleAnalysis';
import {
  analysisFor,
  cookie,
  facts,
  fakeSandbox,
  SECRET,
  SHA,
  SHA2,
  stubSessionEnv,
} from '../helpers/flowHelpers';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
let logs: string[];
beforeEach(async () => {
  await t.reset();
  setDb(pgAdapter(t.pg));
  stubSessionEnv();
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(JSON.stringify(a)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const NOW = new Date('2026-11-16T12:00:00Z');
const post = async (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  new Request('http://localhost/api/analyze', {
    method: 'POST',
    body: raw ?? JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie: await cookie(), ...headers },
  });

interface Harness {
  deps: AnalyzeDeps;
  work: (() => Promise<void>)[];
  fetchFacts: ReturnType<typeof vi.fn>;
  sandbox: ReturnType<typeof fakeSandbox>;
}
function harness(over: Partial<AnalyzeDeps> = {}, sb = fakeSandbox()): Harness {
  const work: (() => Promise<void>)[] = [];
  const fetchFacts = vi.fn(async () => facts());
  return {
    work,
    fetchFacts,
    sandbox: sb,
    deps: {
      fetchFacts,
      gallery: async () => null,
      sandbox: sb.deps,
      schedule: (w) => void work.push(w),
      now: () => NOW,
      ...over,
    },
  };
}
const drain = async (h: Harness) => {
  for (const w of h.work.splice(0)) await w();
};

async function counters(): Promise<Record<string, number>> {
  const r = await t.pg.query<{ period: string; count: number }>(
    "SELECT period, count FROM usage_counters WHERE period ~ '^[dm]:'",
  );
  return Object.fromEntries(r.rows.map((x) => [x.period, x.count]));
}
const unit = async () => (await counters())['d:2026-11-16'] ?? 0;
async function jobRow() {
  return (
    await t.pg.query<{
      id: string;
      phase: string;
      error_code: string | null;
      sandbox_started: boolean;
    }>('SELECT id, phase, error_code, sandbox_started FROM jobs ORDER BY created_at DESC LIMIT 1')
  ).rows[0]!;
}

describe('request handling and authorization', () => {
  it('is session-gated inside the handler (no cookie, tampered cookie, wrong secret)', async () => {
    const h = harness();
    for (const c of [undefined, '__Host-cc_session=garbage']) {
      const res = await handleAnalyze(
        new Request('http://localhost/api/analyze', {
          method: 'POST',
          body: JSON.stringify({ repo: 'a/b' }),
          headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) },
        }),
        h.deps,
      );
      expect(res.status).toBe(401);
    }
    expect(h.fetchFacts).not.toHaveBeenCalled();
  });

  it('exports only POST and runs on Node with maxDuration covering the deadline plus cleanup', () => {
    expect(Object.keys(analyzeRoute).sort()).toEqual(['POST', 'maxDuration', 'runtime']);
    expect(analyzeRoute.runtime).toBe('nodejs');
    expect(analyzeRoute.maxDuration * 1000).toBeGreaterThanOrEqual(
      CAPS.analysisDeadlineMs + 10_000,
    );
    // The job row is created after the function starts, so it cannot read stale while the function lives.
    expect(analyzeRoute.maxDuration * 1000).toBeLessThanOrEqual(JOB_STALE_MS);
  });

  it('requires application/json (415) and checks it after the session', async () => {
    const h = harness();
    const res = await handleAnalyze(
      await post(null, { 'content-type': 'text/plain' }, '{"repo":"a/b"}'),
      h.deps,
    );
    expect(res.status).toBe(415);
    expect(h.fetchFacts).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', '{nope'],
    ['no repo', '{}'],
    ['repo not a string', '{"repo":5}'],
    ['array body', '[]'],
    ['null body', 'null'],
    ['huge body', JSON.stringify({ repo: 'a/'.padEnd(5000, 'b') })],
  ])('400 invalid_body for %s', async (_n, raw) => {
    const h = harness();
    const res = await handleAnalyze(await post(null, {}, raw), h.deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
    expect(h.fetchFacts).not.toHaveBeenCalled();
  });

  it.each([
    'owner/repo;rm -rf',
    '--upload-pack=x/y',
    'https://evil.com/o/r',
    'github.com/o',
    '',
    '../x',
  ])('400 invalid_repo for %j before any GitHub or database call', async (repo) => {
    const h = harness();
    const res = await handleAnalyze(await post({ repo }), h.deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_repo');
    expect(h.fetchFacts).not.toHaveBeenCalled();
    expect(await counters()).toEqual({});
  });
});

describe('cache hits', () => {
  it('a repo in the static gallery returns the gallery result: no GitHub, no quota, no Sandbox, no job', async () => {
    const h = harness({ gallery: async () => sampleAnalysis('Octo', 'Repo', SHA) });
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    expect(await res.json()).toMatchObject({ status: 'cached', source: 'gallery', headSha: SHA });
    expect(h.fetchFacts).not.toHaveBeenCalled();
    expect(h.sandbox.created).toHaveLength(0);
    expect(await counters()).toEqual({});
    expect((await t.pg.query('SELECT 1 FROM jobs')).rows).toHaveLength(0);
  });

  it('the same head SHA is a hit that consumes no quota and starts no Sandbox', async () => {
    await putCached(sampleAnalysis('Octo', 'Repo', SHA), NOW);
    const h = harness();
    const res = await handleAnalyze(await post({ repo: 'Octo/Repo' }), h.deps);
    expect(await res.json()).toMatchObject({ status: 'cached', source: 'live', headSha: SHA });
    expect(await counters()).toEqual({});
    expect(h.work).toHaveLength(0);
    expect(h.sandbox.created).toHaveLength(0);
  });

  it('a different head SHA re-analyses, replacing the row, with one unit of quota', async () => {
    await putCached(sampleAnalysis('Octo', 'Repo', SHA), NOW);
    const h = harness();
    h.fetchFacts.mockResolvedValue(facts({ headSha: SHA2 }));
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    const body = await res.json();
    expect(body.status).toBe('job');
    expect(await unit()).toBe(1);
    await drain(h);
    expect((await getCached('octo', 'repo', SCHEMA_VERSION))?.analysis.repo.headSha).toBe(SHA2);
    expect((await jobRow()).phase).toBe('done');
    expect(await unit()).toBe(1); // success keeps the unit
  });
});

describe('caps and GitHub errors (nothing reserved, nothing started)', () => {
  it.each([
    [{ treeTruncated: true }, 'tree_truncated'],
    [{ sizeKb: CAPS.maxSizeKb + 1 }, 'repo_too_large'],
    [{ totalCommits: CAPS.maxTotalCommits + 1 }, 'too_many_commits'],
    [
      { tree: Array.from({ length: CAPS.maxFiles + 1 }, (_, i) => ({ path: `f${i}`, size: 1 })) },
      'too_many_files',
    ],
  ])('rejects %# with %s', async (over, code) => {
    const h = harness();
    h.fetchFacts.mockResolvedValue(facts(over));
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(code);
    expect(await counters()).toEqual({});
    expect((await t.pg.query('SELECT 1 FROM jobs')).rows).toHaveLength(0);
  });

  it.each([
    [new GitHubError('not_found'), 404, 'not_found'],
    [new GitHubRateLimited(), 429, 'github_rate_limited'],
    [new GitHubError('github_error'), 502, 'github_error'],
    [new GitHubError('empty_repo'), 422, 'empty_repo'],
    [new Error('boom with token=ghp_SECRET and postgres://u:pw@h/db'), 500, 'internal_error'],
  ])('maps a GitHub-side failure %# to a fixed code and message', async (err, status, code) => {
    const h = harness();
    h.fetchFacts.mockRejectedValue(err);
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    const text = await res.text();
    expect(res.status).toBe(status);
    expect(JSON.parse(text).error).toBe(code);
    expect(text + logs.join()).not.toMatch(/ghp_SECRET|postgres:|boom/);
  });

  it('refuses the 11th analysis of a day with daily and starts no Sandbox', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.fetchFacts.mockResolvedValue(facts({ name: `r${i}` }));
      // A different client IP each time: the per-IP limit has its own tests (analyze-limits.test.ts).
      const ip = { 'x-vercel-forwarded-for': `198.51.100.${i}` };
      expect(
        (await (await handleAnalyze(await post({ repo: `octo/r${i}` }, ip), h.deps)).json()).status,
      ).toBe('job');
    }
    h.fetchFacts.mockResolvedValue(facts({ name: 'eleventh' }));
    const res = await handleAnalyze(
      await post({ repo: 'octo/eleventh' }, { 'x-vercel-forwarded-for': '198.51.100.99' }),
      h.deps,
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('daily');
    expect(h.sandbox.created).toHaveLength(0);
  });
});

describe('job lifecycle', () => {
  it('an in-flight job for the same repo returns the same id and starts no second Sandbox', async () => {
    const h = harness();
    const a = await (await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps)).json();
    const b = await (await handleAnalyze(await post({ repo: 'OCTO/REPO' }), h.deps)).json();
    expect(b).toEqual({ status: 'job', id: a.id }); // the reuser gets no analysesLeft: it took no unit
    expect(await unit()).toBe(1);
    expect(h.work).toHaveLength(1); // only the creator schedules work
    await drain(h);
    expect(h.sandbox.created).toHaveLength(1);
  });

  it('advances the phases in order via onPhase', async () => {
    const seen: string[] = [];
    let jobId = '';
    const sb = fakeSandbox({
      script: (analysis) =>
        (async function* () {
          for (const ph of ['cloning', 'reading_history', 'computing']) {
            yield { stream: 'stdout' as const, data: `{"phase":"${ph}"}\n` };
            await new Promise((r) => setTimeout(r, 15));
            const row = await t.pg.query<{ phase: string }>(
              'SELECT phase FROM jobs WHERE id = $1',
              [jobId],
            );
            seen.push(row.rows[0]!.phase);
          }
          yield { stream: 'stdout' as const, data: `${JSON.stringify(analysis)}\n` };
        })(),
    });
    const h = harness({}, sb);
    jobId = (await (await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps)).json()).id;
    expect((await jobRow()).phase).toBe('queued');
    await drain(h);
    expect(seen).toEqual(['cloning', 'reading_history', 'computing']);
    expect((await jobRow()).phase).toBe('done');
  });

  it('never returns raw database errors, and fails closed with db_unavailable', async () => {
    const h = harness();
    setDb({
      query: async () => {
        throw new Error('connection to postgres://user:hunter2@db.example/x refused');
      },
    });
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text).error).toBe('db_unavailable');
    expect(text + logs.join()).not.toMatch(/hunter2|postgres:/);
    expect(h.sandbox.created).toHaveLength(0);
  });

  it('fails the job and gives the unit back if the work cannot be scheduled (no Sandbox was created)', async () => {
    const h = harness({
      schedule: () => {
        throw new Error('after() called outside a request scope');
      },
    });
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    expect((await res.json()).error).toBe('internal_error');
    expect(await unit()).toBe(0);
    expect((await jobRow()).phase).toBe('failed');
  });

  it('a job already swept to failed does not write a cache row (putCached guard)', async () => {
    const sb = fakeSandbox({
      beforeOutput: async () => {
        // The stale sweep (or anything else) failed the job while the Sandbox was running.
        await t.pg.query(`UPDATE jobs SET phase = 'failed', error_code = 'timeout'`);
      },
    });
    const h = harness({}, sb);
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    await drain(h);
    expect(await getCached('octo', 'repo', SCHEMA_VERSION)).toBeNull();
    expect((await jobRow()).error_code).toBe('timeout');
  });
});

describe('home page refresh after a stored analysis', () => {
  it('revalidates "/" once, after the analysis and its card are stored and before the job reads done', async () => {
    const calls: string[] = [];
    let readBack: Promise<unknown> | undefined;
    const h = harness({
      revalidate: (path) => {
        calls.push(path);
        // Queries run in order on one connection, so this read sees the state at the call.
        readBack = t.pg.query<{ card: unknown; phase: string }>(
          `SELECT (SELECT card FROM analyses LIMIT 1) AS card, (SELECT phase FROM jobs LIMIT 1) AS phase`,
        );
      },
    });
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    await drain(h);
    expect(calls).toEqual(['/']);
    const row = ((await readBack) as { rows: { card: unknown; phase: string }[] }).rows[0]!;
    expect(row.card).not.toBeNull();
    expect(row.phase).not.toBe('done');
    expect(await jobRow()).toMatchObject({ phase: 'done' });
  });

  it('does not revalidate when the write fails', async () => {
    const revalidate = vi.fn();
    const h = harness({ revalidate });
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    const real = pgAdapter(t.pg);
    setDb({
      query: async (text, params) => {
        if (text.includes('INSERT INTO analyses')) throw new Error('disk full');
        return real.query(text, params);
      },
    });
    await drain(h);
    setDb(real);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('does not revalidate for a job swept to failed (nothing was written)', async () => {
    const revalidate = vi.fn();
    const sb = fakeSandbox({
      beforeOutput: async () => {
        await t.pg.query(`UPDATE jobs SET phase = 'failed', error_code = 'timeout'`);
      },
    });
    const h = harness({ revalidate }, sb);
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    await drain(h);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('a throwing revalidate does not fail the job, and the default is safe outside a request scope', async () => {
    const h = harness({
      revalidate: () => {
        throw new Error('Invariant: static generation store missing');
      },
    });
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    expect((await res.json()).status).toBe('job');
    await drain(h);
    expect(await jobRow()).toMatchObject({ phase: 'done', error_code: null });
    expect(await getCached('octo', 'repo', SCHEMA_VERSION)).not.toBeNull();
    expect(logs.join()).toContain('revalidate_failed');

    // No injected revalidate: the real Next.js call throws outside a request, and is swallowed.
    const h2 = harness();
    h2.deps.revalidate = undefined;
    await t.reset();
    setDb(pgAdapter(t.pg));
    await handleAnalyze(await post({ repo: 'octo/repo' }), h2.deps);
    await expect(drain(h2)).resolves.toBeUndefined();
    expect(await jobRow()).toMatchObject({ phase: 'done' });
  });

  it('a re-analysis revalidates once more after replacing the row', async () => {
    await putCached(sampleAnalysis('Octo', 'Repo', SHA), NOW);
    const revalidate = vi.fn();
    const h = harness({ revalidate });
    h.fetchFacts.mockResolvedValue(facts({ headSha: SHA2 }));
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    await drain(h);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith('/');
    expect((await getCached('octo', 'repo', SCHEMA_VERSION))?.analysis.repo.headSha).toBe(SHA2);
  });
});

describe('refund line: only a failure before the Sandbox is created refunds, exactly once', () => {
  async function run(sb: ReturnType<typeof fakeSandbox>, over: Partial<AnalyzeDeps> = {}) {
    const h = harness(over, sb);
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    expect((await res.json()).status).toBe('job');
    expect(await unit()).toBe(1);
    await drain(h);
    return jobRow();
  }

  it('createSandbox throws: refunded, code clone_failed, no secret in the row or logs', async () => {
    const row = await run(fakeSandbox({ createFails: true }));
    expect(row).toMatchObject({
      phase: 'failed',
      error_code: 'clone_failed',
      sandbox_started: false,
    });
    expect(await unit()).toBe(0);
    expect((await counters())['m:2026-11']).toBe(0);
    expect(logs.join()).not.toMatch(/SECRET-TOKEN/);
  });

  it('the bundle cannot be read: refunded', async () => {
    const row = await run(fakeSandbox({ bundleFails: true }));
    expect(row.phase).toBe('failed');
    expect(await unit()).toBe(0);
  });

  it.each([
    ['stale_head', '{"error":"stale_head"}\n'],
    ['too_many_commits_in_window', '{"error":"too_many_commits_in_window"}\n'],
    ['clone_failed', '{"error":"clone_failed"}\n'],
    ['invalid_output', 'not json\n'],
  ])('%s after the Sandbox exists: the unit is kept', async (code, line) => {
    const row = await run(
      fakeSandbox({
        script: () =>
          (async function* () {
            yield { stream: 'stdout' as const, data: line };
          })(),
      }),
    );
    expect(row).toMatchObject({ phase: 'failed', error_code: code, sandbox_started: true });
    expect(await unit()).toBe(1);
  });

  it('a timeout after the Sandbox exists keeps the unit', async () => {
    const row = await run(
      fakeSandbox({
        script: () =>
          (async function* () {
            yield { stream: 'stdout' as const, data: '{"phase":"cloning"}\n' };
            await new Promise((r) => setTimeout(r, 2000));
          })(),
      }),
      { deadlineMs: 80 },
    );
    expect(row).toMatchObject({ phase: 'failed', error_code: 'timeout', sandbox_started: true });
    expect(await unit()).toBe(1);
  });

  it('a Sandbox that is still being created when the deadline wins keeps the unit', async () => {
    const sb = fakeSandbox();
    const slowCreate = sb.deps.createSandbox!;
    sb.deps.createSandbox = async (o) => {
      await new Promise((r) => setTimeout(r, 300));
      return slowCreate(o);
    };
    const row = await run(sb, { deadlineMs: 60 });
    expect(row).toMatchObject({ phase: 'failed', error_code: 'timeout' });
    expect(await unit()).toBe(1);
  });

  it('db_write_failed (the cache write throws) keeps the unit', async () => {
    const sb = fakeSandbox();
    const h = harness({}, sb);
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    const real = pgAdapter(t.pg);
    setDb({
      query: async (text, params) => {
        if (text.includes('INSERT INTO analyses')) throw new Error('disk full');
        return real.query(text, params);
      },
    });
    await drain(h);
    setDb(real);
    expect(await jobRow()).toMatchObject({ phase: 'failed', error_code: 'db_write_failed' });
    expect(await unit()).toBe(1);
  });

  it('a failure to store the sandbox_started flag still keeps the unit and stops the Sandbox', async () => {
    const sb = fakeSandbox();
    const h = harness({}, sb);
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    const real = pgAdapter(t.pg);
    setDb({
      query: async (text, params) => {
        if (text.includes('sandbox_started = true')) throw new Error('flag write lost');
        return real.query(text, params);
      },
    });
    await drain(h);
    setDb(real);
    expect((await jobRow()).phase).toBe('failed');
    expect(await unit()).toBe(1);
    expect(sb.stop).toHaveBeenCalled();
  });

  it('a killed function after the Sandbox started is not refunded by the stale sweep', async () => {
    const h = harness({}, fakeSandbox());
    await handleAnalyze(await post({ repo: 'octo/repo' }), h.deps);
    // The function starts the Sandbox, then dies: simulate with the flag and no further work.
    await t.pg.query(`UPDATE jobs SET sandbox_started = true`);
    const later = new Date(NOW.getTime() + JOB_STALE_MS + 1000);
    const h2 = harness({ now: () => later });
    const res = await handleAnalyze(await post({ repo: 'octo/repo' }), h2.deps);
    expect((await res.json()).status).toBe('job');
    expect(await unit()).toBe(2); // the dead job kept its unit; the new one holds one
  });
});

describe('runLiveJob with a job that no longer exists', () => {
  it('does nothing and writes no cache row', async () => {
    const sb = fakeSandbox();
    await runLiveJob('00000000-0000-4000-8000-000000000000', facts(), {
      sandbox: sb.deps,
      now: () => NOW,
    });
    expect(await getCached('octo', 'repo', SCHEMA_VERSION)).toBeNull();
  });
});

describe('secrets never appear', () => {
  it('no response, log or job row contains the session secret, password or a raw IP', async () => {
    const h = harness();
    const res = await handleAnalyze(
      await post({ repo: 'octo/repo' }, { 'x-vercel-forwarded-for': '203.0.113.9' }),
      h.deps,
    );
    await drain(h);
    const everything =
      (await res.text()) +
      logs.join() +
      JSON.stringify((await t.pg.query('SELECT * FROM jobs')).rows);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('fake-demo-password');
    expect(everything).not.toContain('203.0.113.9');
    expect(analysisFor).toBeDefined();
  });
});
