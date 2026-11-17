import { afterEach, describe, expect, it } from 'vitest';
import { parseAnalysis, SCHEMA_VERSION } from '@/lib/analysis/schema';
import { CAPS, MAX_ANALYSIS_BYTES } from '@/lib/caps';
import { analyze, windowStart } from '@/lib/ingest/analyze';
import { gitLogRaw, makeRepo, type ScriptedCommit } from '../helpers/makeRepo';

const DAY = 86_400;
const T0 = 1_700_000_000;
const REPO = {
  owner: 'octo',
  name: 'demo',
  headSha: 'a'.repeat(40),
  defaultBranch: 'main',
};

/** Builds one record of the `-z` history format without running git. */
function rec(
  n: number,
  author: string,
  email: string,
  time: number,
  subject: string,
  files: string[],
): string {
  const hash = n.toString(16).padStart(40, '0');
  return `\x1e${hash}\x1f${author}\x1f${email}\x1f${time}\x1f${subject}\0\n${files.map((f) => `${f}\0`).join('')}`;
}

function shuffle<T>(items: T[]): T[] {
  // Deterministic reorder (no Math.random): reverse then interleave halves.
  const rev = [...items].reverse();
  const half = Math.ceil(rev.length / 2);
  const out: T[] = [];
  for (let i = 0; i < half; i++) {
    out.push(rev[i] as T);
    if (rev[i + half] !== undefined) out.push(rev[i + half] as T);
  }
  return out;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await (cleanups.pop() as () => Promise<void>)();
});

async function fixture(commits: ScriptedCommit[]) {
  const repo = await makeRepo(commits);
  cleanups.push(repo.cleanup);
  return repo;
}

function scripted(n: number): ScriptedCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    author: i % 2 === 0 ? 'alice@example.com' : 'Bob Builder',
    email: i % 2 === 0 ? 'alice@example.com' : 'bob@example.com',
    time: T0 + i * DAY,
    subject: i % 4 === 0 ? 'fix: crash on start' : `change ${i}`,
    files: { 'src/app.ts': `v${i}`, [`src/mod${i % 3}.ts`]: `m${i}` },
  }));
}

describe('windowStart', () => {
  it('is 24 months earlier', () => {
    const latest = Date.UTC(2026, 10, 15, 12, 30) / 1000;
    expect(windowStart(latest)).toBe(Date.UTC(2024, 10, 15, 12, 30) / 1000);
  });

  it('handles a leap day (29 Feb two years on from a leap year clamps to 28 Feb)', () => {
    const latest = Date.UTC(2024, 1, 29, 8) / 1000;
    expect(windowStart(latest)).toBe(Date.UTC(2022, 1, 28, 8) / 1000);
  });

  it('handles a latest commit that is 1 Mar after a leap year', () => {
    const latest = Date.UTC(2026, 2, 1) / 1000;
    expect(windowStart(latest)).toBe(Date.UTC(2024, 2, 1) / 1000);
  });
});

describe('analyze end to end on a real fixture repo', () => {
  // Slow part: the fixture runs a real `git` child process per commit (25 commits plus init), and process
  // spawns are slow on Windows, so this test can pass 5 s there. The analysis itself takes milliseconds.
  it('passes parseAnalysis and contains no @ anywhere', { timeout: 20_000 }, async () => {
    const { dir } = await fixture(scripted(25));
    const raw = gitLogRaw(dir);
    const latest = T0 + 24 * DAY;
    const analysis = analyze({
      repo: REPO,
      rawLog: raw,
      head: [
        { path: 'src/app.ts', size: 100 },
        { path: 'src/mod0.ts', size: 10 },
        { path: 'src/mod1.ts', size: 10 },
        { path: 'src/mod2.ts', size: 10 },
      ],
      windowFromUnix: windowStart(latest),
    });
    expect(parseAnalysis(JSON.parse(JSON.stringify(analysis)))).toEqual(analysis);
    expect(JSON.stringify(analysis)).not.toContain('@');
    expect(analysis.schemaVersion).toBe(SCHEMA_VERSION);
    expect(analysis.repo).toEqual(REPO);
    expect(analysis.stats.commitsInWindow).toBe(25);
    expect(analysis.stats.thinHistory).toBe(false);
    expect(analysis.window).toEqual({ from: windowStart(latest), to: latest, commits: 25 });
    const app = analysis.files.find((f) => f.path === 'src/app.ts');
    expect(app?.changes).toBe(25);
    expect(app?.mainAuthor).toBe('alice');
    // alice's commits are i = 0, 2, ..., 24, and 0, 4, ..., 24 are bug fixes.
    expect(analysis.stats.bugFixCommitShare).toBeCloseTo(7 / 25, 10);
    expect(analysis.districts.map((d) => d.path)).toContain('src');
    expect(
      analysis.districts.every((d) => d.ownerName === null || !d.ownerName.includes('@')),
    ).toBe(true);
  });

  it('fills co-change from the commits', { timeout: 20_000 }, async () => {
    const { dir } = await fixture(scripted(25));
    const analysis = analyze({
      repo: REPO,
      rawLog: gitLogRaw(dir),
      head: [
        { path: 'src/app.ts', size: 100 },
        { path: 'src/mod0.ts', size: 10 },
      ],
      windowFromUnix: 0,
    });
    const app = analysis.files.find((f) => f.path === 'src/app.ts');
    expect(app?.coChange.map((c) => c.path)).toEqual(['src/mod0.ts']);
  });
});

describe('thin and empty history', () => {
  it('flags 3 commits as thin and 20 as not thin', () => {
    const log = (n: number) =>
      Array.from({ length: n }, (_, i) => rec(i + 1, 'A', 'a@x.test', T0 + i, 's', ['a.ts'])).join(
        '',
      );
    const head = [{ path: 'a.ts', size: 5 }];
    const three = analyze({ repo: REPO, rawLog: log(3), head, windowFromUnix: 0 });
    expect(three.stats.thinHistory).toBe(true);
    expect(three.stats.commitsInWindow).toBe(3);
    const twenty = analyze({ repo: REPO, rawLog: log(20), head, windowFromUnix: 0 });
    expect(twenty.stats.thinHistory).toBe(false);
    expect(twenty.stats.commitsInWindow).toBe(20);
    parseAnalysis(JSON.parse(JSON.stringify(three)));
  });

  it('returns a valid analysis with every file cold for an empty log', () => {
    const a = analyze({
      repo: REPO,
      rawLog: '',
      head: [
        { path: 'a.ts', size: 5 },
        { path: 'dir/b.ts', size: 7 },
      ],
      windowFromUnix: 1000,
    });
    parseAnalysis(JSON.parse(JSON.stringify(a)));
    expect(a.files.every((f) => f.changes === 0 && f.lastChanged === null)).toBe(true);
    expect(a.stats).toMatchObject({
      bugFixCommitShare: 0,
      botCommitsExcluded: 0,
      commitsInWindow: 0,
      thinHistory: true,
    });
    expect(a.window).toEqual({ from: 1000, to: 1000, commits: 0 });
  });

  it('handles an empty head', () => {
    const a = analyze({
      repo: REPO,
      rawLog: rec(1, 'A', 'a@x.test', T0, 's', ['x']),
      head: [],
      windowFromUnix: 0,
    });
    expect(a.files).toEqual([]);
    parseAnalysis(JSON.parse(JSON.stringify(a)));
  });
});

describe('stats', () => {
  it('echoes mailmapApplied (default false)', () => {
    const base = { repo: REPO, rawLog: '', head: [], windowFromUnix: 0 };
    expect(analyze(base).stats.mailmapApplied).toBe(false);
    expect(analyze({ ...base, mailmapApplied: true }).stats.mailmapApplied).toBe(true);
  });

  it('counts bot commits and excludes them from the commit count and bug-fix share', () => {
    const log = [
      rec(1, 'Ann', 'ann@x.test', T0, 'fix crash', ['a.ts']),
      rec(2, 'Ann', 'ann@x.test', T0 + 1, 'add thing', ['a.ts']),
      rec(3, 'dependabot[bot]', 'bot@x.test', T0 + 2, 'fix deps', ['a.ts']),
      rec(4, 'renovate[bot]', 'r@x.test', T0 + 3, 'bump', ['a.ts']),
    ].join('');
    const a = analyze({
      repo: REPO,
      rawLog: log,
      head: [{ path: 'a.ts', size: 1 }],
      windowFromUnix: 0,
    });
    expect(a.stats.botCommitsExcluded).toBe(2);
    expect(a.stats.commitsInWindow).toBe(2);
    expect(a.stats.bugFixCommitShare).toBe(0.5);
    expect(a.files[0]?.changes).toBe(2);
  });

  it('ignores commits older than the window and those in dropHashes', () => {
    const log = [
      rec(1, 'Ann', 'ann@x.test', 50, 's', ['a.ts']),
      rec(2, 'Ann', 'ann@x.test', 150, 's', ['a.ts']),
      rec(3, 'Ann', 'ann@x.test', 160, 's', ['a.ts']),
    ].join('');
    const a = analyze({
      repo: REPO,
      rawLog: log,
      head: [{ path: 'a.ts', size: 1 }],
      windowFromUnix: 100,
      dropHashes: new Set([(3).toString(16).padStart(40, '0')]),
    });
    expect(a.stats.commitsInWindow).toBe(1);
    expect(a.window).toEqual({ from: 100, to: 150, commits: 1 });
  });
});

describe('caps', () => {
  it('skips a 1,025-character path, records path_too_long and stays valid', () => {
    const long = `${'p'.repeat(1021)}.ts`; // 1,024 characters is allowed; use one more below
    const tooLong = `${long}x`;
    expect(tooLong.length).toBe(1025);
    const log = rec(1, 'Ann', 'ann@x.test', T0, 's', ['ok.ts', tooLong, long]);
    const a = analyze({
      repo: REPO,
      rawLog: log,
      head: [
        { path: 'ok.ts', size: 1 },
        { path: tooLong, size: 1 },
        { path: long, size: 1 },
      ],
      windowFromUnix: 0,
    });
    expect(a.stats.capsHit).toEqual(['path_too_long']);
    expect(a.files.map((f) => f.path)).toEqual([long, 'ok.ts'].sort());
    parseAnalysis(JSON.parse(JSON.stringify(a)));
  });

  it('has no capsHit codes for an ordinary repo', () => {
    const a = analyze({
      repo: REPO,
      rawLog: '',
      head: [{ path: 'a.ts', size: 1 }],
      windowFromUnix: 0,
    });
    expect(a.stats.capsHit).toEqual([]);
  });

  function manyFolders(): { head: { path: string; size: number }[]; log: string[] } {
    const head: { path: string; size: number }[] = [];
    const log: string[] = [];
    let n = 1;
    // 100 low-change folders sort first by path; 2,000 folders with 2 changes each come after.
    for (let i = 0; i < 100; i++) {
      const p = `a${String(i).padStart(4, '0')}/f.ts`;
      head.push({ path: p, size: 1 });
      log.push(rec(n++, 'Ann', 'ann@x.test', T0 + n, 's', [p]));
    }
    for (let i = 0; i < 2000; i++) {
      const p = `z${String(i).padStart(4, '0')}/f.ts`;
      head.push({ path: p, size: 1 });
      log.push(rec(n++, 'Ann', 'ann@x.test', T0 + n, 's', [p]));
      log.push(rec(n++, 'Ann', 'ann@x.test', T0 + n, 's', [p]));
    }
    return { head, log };
  }

  it('truncates districts to the 2,000 with the most changes', () => {
    const { head, log } = manyFolders();
    const a = analyze({ repo: REPO, rawLog: log.join(''), head, windowFromUnix: 0 });
    expect(a.districts).toHaveLength(2000);
    expect(a.districts.every((d) => d.path.startsWith('z') && d.changes === 2)).toBe(true);
    expect(a.stats.capsHit).toEqual(['districts_truncated']);
    parseAnalysis(JSON.parse(JSON.stringify(a)));
  });

  it('breaks change ties by path ascending, independent of input order', () => {
    const head: { path: string; size: number }[] = [];
    const log: string[] = [];
    for (let i = 0; i < 2100; i++) {
      const p = `d${String(i).padStart(4, '0')}/f.ts`;
      head.push({ path: p, size: 1 });
      log.push(rec(i + 1, 'Ann', 'ann@x.test', T0 + i, 's', [p]));
    }
    const run = (h: typeof head, l: string[]) =>
      analyze({ repo: REPO, rawLog: l.join(''), head: h, windowFromUnix: 0 }).districts.map(
        (d) => d.path,
      );
    const expected = Array.from({ length: 2000 }, (_, i) => `d${String(i).padStart(4, '0')}`);
    expect(run(head, log)).toEqual(expected);
    expect(run(shuffle(head), shuffle(log))).toEqual(expected);
    expect(run([...head].reverse(), [...log].reverse())).toEqual(expected);
  });

  it('keeps exactly 2,000 districts without flagging when there are exactly 2,000', () => {
    const head = Array.from({ length: 2000 }, (_, i) => ({
      path: `d${String(i).padStart(4, '0')}/f.ts`,
      size: 1,
    }));
    const a = analyze({ repo: REPO, rawLog: '', head, windowFromUnix: 0 });
    expect(a.districts).toHaveLength(2000);
    expect(a.stats.capsHit).toEqual([]);
  });
});

describe('serialised size', () => {
  it('is best effort: paths alone over the bound stay over it, flagged, for parseAnalysis to reject', () => {
    const head = Array.from({ length: 10_000 }, (_, i) => ({
      path: `${String(i).padStart(5, '0')}${'p'.repeat(1000)}`,
      size: 1,
    }));
    const result = analyze({ repo: REPO, rawLog: '', head, windowFromUnix: 0 });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeGreaterThan(CAPS.maxStdoutBytes);
    expect(result.stats.capsHit).toContain('size_trimmed');
    expect(() => parseAnalysis(JSON.parse(JSON.stringify(result)))).toThrow();
  });

  it('stays valid for a 10,000-file repo whose files each carry 5 authors and 5 co-change partners', () => {
    const head: { path: string; size: number }[] = [];
    const log: string[] = [];
    let n = 1;
    const groups = 1666;
    for (let g = 0; g < groups; g++) {
      const dir = `packages/module-${String(g).padStart(4, '0')}/src/components/internal`;
      const files = Array.from({ length: 6 }, (_, k) => `${dir}/component-${k}.tsx`);
      for (const p of files) head.push({ path: p, size: 1000 + g });
      for (let a = 0; a < 6; a++) {
        log.push(rec(n++, `Author Number ${a}`, `author${a}@x.test`, T0 + n, 'work', files));
      }
    }
    const result = analyze({ repo: REPO, rawLog: log.join(''), head, windowFromUnix: 0 });
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(result.files).toHaveLength(groups * 6);
    expect(bytes).toBeGreaterThan(CAPS.maxStdoutBytes * 0.5);
    // Headroom: the printed line plus phase lines and a newline must stay within the runner's stdout cap.
    expect(bytes).toBeLessThanOrEqual(MAX_ANALYSIS_BYTES);
    expect(MAX_ANALYSIS_BYTES).toBe(CAPS.maxStdoutBytes - 1024);
    expect(result.stats.capsHit).toEqual(['size_trimmed']);
    // Trimmed, not emptied: co-change is reduced, the main author is kept, report card intact.
    expect(result.files[0]?.coChange.length).toBeLessThan(5);
    expect(result.files[0]?.mainAuthor).not.toBeNull();
    expect(result.report.readFirst.length).toBeGreaterThan(0);
    parseAnalysis(JSON.parse(JSON.stringify(result)));
  });
});
