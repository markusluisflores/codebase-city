import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAnalysis } from '@/lib/analysis/schema';
import { GIT_LOG_ARGS } from '@/lib/ingest/parseLog';
import {
  cloneArgs,
  cloneUrl,
  HARDENING_CONFIG,
  runJob,
  type Exec,
  type JobDeps,
} from '@/lib/sandbox/job';
import { makeRepo, type ScriptedCommit } from '../helpers/makeRepo';

const T0 = 1_700_000_000;
const DAY = 86_400;
const WINDOW = T0 - 30 * DAY;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function commit(n: number, files: Record<string, string>, who = 'Ann', mail = 'ann@x.test') {
  return {
    author: who,
    email: mail,
    time: T0 + n * DAY,
    subject: `work ${n}`,
    files,
  } satisfies ScriptedCommit;
}

function realGit(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

/** A local fixture repo, served over file:// with the same filter support GitHub has. */
async function fixture(commits: ScriptedCommit[]) {
  const repo = await makeRepo(commits);
  cleanups.push(repo.cleanup);
  realGit(repo.dir, ['config', 'uploadpack.allowFilter', 'true']);
  realGit(repo.dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const sha = realGit(repo.dir, ['rev-parse', 'refs/heads/main']);
  return { dir: repo.dir, sha, url: pathToFileURL(repo.dir).href };
}

async function sizesFile(files: { path: string; size: number }[]): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'cc-sizes-'));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  const p = join(d, 'sizes.json');
  writeFileSync(p, JSON.stringify(files));
  return p;
}

type Run = { code: number; lines: string[]; calls: string[][] };

async function run(
  argv: string[],
  url: string,
  extra: Partial<JobDeps> = {},
  spy = true,
): Promise<Run> {
  const lines: string[] = [];
  const calls: string[][] = [];
  const { execFileSync: ex } = await import('node:child_process');
  const real: Exec = (args, opts = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...opts.env,
    };
    return ex('git', args, {
      cwd: opts.cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const exec: Exec = (args, opts) => {
    if (spy) calls.push(args);
    return real(args, opts);
  };
  const code = await runJob(argv, {
    exec,
    urlFor: () => url,
    extraGitConfig: ['-c', 'protocol.file.allow=always'],
    write: (l) => lines.push(l),
    ...extra,
  });
  return { code, lines: lines.map((l) => l.replace(/\n$/, '')), calls };
}

const good = (sha: string, sizes: string, win = String(WINDOW)) => [
  '--',
  'octo',
  'demo',
  sha,
  'main',
  win,
  sizes,
];

describe('job: git commands', () => {
  it('builds the clone from validated owner and name only', () => {
    expect(cloneUrl('octo', 'demo.js')).toBe('https://github.com/octo/demo.js.git');
    for (const bad of ['--upload-pack=x', 'a;rm', 'a b', '-x', '', '../x', 'a/b']) {
      expect(() => cloneUrl(bad, 'demo')).toThrow();
      expect(() => cloneUrl('octo', bad)).toThrow();
    }
  });

  it('clones blobless without checkout, hooks and fsmonitor off, and positionals only after --', () => {
    const args = cloneArgs('https://github.com/octo/demo.git', '/tmp/x', WINDOW);
    expect(args).toEqual(expect.arrayContaining(['--filter=blob:none', '--no-checkout']));
    for (const c of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'protocol.allow=never']) {
      expect(HARDENING_CONFIG).toContain(c);
      expect(args).toContain(c);
    }
    const sep = args.indexOf('--');
    expect(args.slice(sep + 1)).toEqual(['https://github.com/octo/demo.git', '/tmp/x']);
    expect(args.slice(0, sep).some((a) => a.includes('octo'))).toBe(false);
    expect(args.indexOf('clone')).toBeLessThan(sep);
  });
});

describe('job against a local fixture repo', () => {
  it('prints phases in order, then one valid Analysis line with the request in repo', async () => {
    const f = await fixture([commit(1, { 'a.ts': '1' }), commit(2, { 'a.ts': '2', 'b.ts': '1' })]);
    const sizes = await sizesFile([
      { path: 'a.ts', size: 10 },
      { path: 'b.ts', size: 5 },
    ]);
    const r = await run(good(f.sha, sizes), f.url);
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 3)).toEqual([
      '{"phase":"cloning"}',
      '{"phase":"reading_history"}',
      '{"phase":"computing"}',
    ]);
    expect(r.lines).toHaveLength(4);
    const a = parseAnalysis(JSON.parse(r.lines[3]!));
    expect(a.repo).toEqual({ owner: 'octo', name: 'demo', headSha: f.sha, defaultBranch: 'main' });
    expect(a.window.commits).toBe(2);
    expect(r.lines.every((l) => !l.includes('\n'))).toBe(true);
  });

  it('runs git log from the given SHA with the shared args and the SHA-form mailmap blob', async () => {
    const f = await fixture([
      commit(1, { 'a.ts': '1' }),
      commit(2, { 'a.ts': '2' }),
      commit(3, { 'c.ts': '1' }),
    ]);
    const second = realGit(f.dir, ['rev-parse', 'refs/heads/main~1']);
    const sizes = await sizesFile([
      { path: 'a.ts', size: 10 },
      { path: 'c.ts', size: 1 },
    ]);
    const r = await run(good(second, sizes), f.url);
    expect(r.code).toBe(0);
    // The clone's HEAD has 3 commits; running from the given SHA sees 2 and never c.ts.
    const a = parseAnalysis(JSON.parse(r.lines.at(-1)!));
    expect(a.window.commits).toBe(2);
    expect(a.files.find((x) => x.path === 'c.ts')?.changes).toBe(0);
    const log = r.calls.find((c) => c.includes('--use-mailmap'))!;
    expect(log).toContain(`mailmap.blob=${second}:.mailmap`);
    expect(log.slice(log.indexOf('log'), log.indexOf('log') + GIT_LOG_ARGS.length)).toEqual([
      ...GIT_LOG_ARGS,
    ]);
    expect(log.at(-2)).toBe(second);
    expect(log.at(-1)).toBe('--');
    expect(log.indexOf('--since=' + WINDOW)).toBeGreaterThan(-1);
    // Every git call carries the hardening config.
    for (const c of r.calls) expect(c).toContain('core.hooksPath=/dev/null');
  });

  it('is silent and unflagged when the repo has no .mailmap, and applies one when present', async () => {
    const plain = await fixture([commit(1, { 'a.ts': '1' })]);
    const sizes = await sizesFile([{ path: 'a.ts', size: 1 }]);
    const r1 = await run(good(plain.sha, sizes), plain.url);
    expect(r1.code).toBe(0);
    expect(parseAnalysis(JSON.parse(r1.lines.at(-1)!)).stats.mailmapApplied).toBe(false);

    const mapped = await fixture([
      commit(
        1,
        { 'a.ts': '1', '.mailmap': 'New Name <new@x.test> <old@x.test>\n' },
        'Old Name',
        'old@x.test',
      ),
    ]);
    const mappedSizes = await sizesFile([
      { path: 'a.ts', size: 1 },
      { path: '.mailmap', size: 40 },
    ]);
    const r2 = await run(good(mapped.sha, mappedSizes), mapped.url);
    const a2 = parseAnalysis(JSON.parse(r2.lines.at(-1)!));
    expect(a2.stats.mailmapApplied).toBe(true);
    expect(a2.files.find((x) => x.path === 'a.ts')?.mainAuthor).toBe('New Name');
  });

  it('fails stale_head when the SHA is absent from the clone', async () => {
    const f = await fixture([commit(1, { 'a.ts': '1' })]);
    const sizes = await sizesFile([{ path: 'a.ts', size: 1 }]);
    const r = await run(good('b'.repeat(40), sizes), f.url);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('{"error":"stale_head"}');
  });

  it('fails too_many_commits_in_window above a lowered cap', async () => {
    const f = await fixture([
      commit(1, { 'a.ts': '1' }),
      commit(2, { 'a.ts': '2' }),
      commit(3, { 'a.ts': '3' }),
    ]);
    const sizes = await sizesFile([{ path: 'a.ts', size: 1 }]);
    const r = await run(good(f.sha, sizes), f.url, {
      caps: { maxCommitsInWindow: 2, maxFiles: 10_000 },
    });
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('{"error":"too_many_commits_in_window"}');
    const ok = await run(good(f.sha, sizes), f.url, {
      caps: { maxCommitsInWindow: 3, maxFiles: 10_000 },
    });
    expect(ok.code).toBe(0);
  });

  it('fails too_many_files before cloning', async () => {
    const f = await fixture([commit(1, { 'a.ts': '1' })]);
    const sizes = await sizesFile([
      { path: 'a.ts', size: 1 },
      { path: 'b.ts', size: 1 },
    ]);
    const r = await run(good(f.sha, sizes), f.url, {
      caps: { maxCommitsInWindow: 10, maxFiles: 1 },
    });
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(['{"error":"too_many_files"}']);
    expect(r.calls).toHaveLength(0);
  });

  it('reports clone_failed with the code only, never git output', async () => {
    const sizes = await sizesFile([{ path: 'a.ts', size: 1 }]);
    const missing = pathToFileURL(join(tmpdir(), 'cc-does-not-exist-xyz')).href;
    const r = await run(good('a'.repeat(40), sizes), missing);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('{"error":"clone_failed"}');
    expect(r.lines.join('')).not.toMatch(/fatal|cc-does-not-exist/);
  });
});

describe('job mailmap size guard', () => {
  it('skips a .mailmap larger than 1 MiB (size from the tree listing) without fetching it', async () => {
    const f = await fixture([commit(1, { 'a.ts': '1', '.mailmap': 'x'.repeat(1024 * 1024 + 1) })]);
    const sizes = await sizesFile([
      { path: 'a.ts', size: 1 },
      { path: '.mailmap', size: 1024 * 1024 + 1 },
    ]);
    const r = await run(good(f.sha, sizes), f.url);
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.some((a) => a.includes('.mailmap')))).toBe(false);
    expect(r.calls.some((c) => c.includes('--use-mailmap'))).toBe(false);
    expect(parseAnalysis(JSON.parse(r.lines.at(-1)!)).stats.mailmapApplied).toBe(false);
  });
});

describe('job output size guard', () => {
  it('fails invalid_output instead of printing a line over MAX_ANALYSIS_BYTES', async () => {
    const f = await fixture([commit(1, { 'a.ts': '1' })]);
    const sizes = await sizesFile([{ path: 'a.ts', size: 1 }]);
    const { analyze } = await import('@/lib/ingest/analyze');
    const { MAX_ANALYSIS_BYTES } = await import('@/lib/caps');
    const oversize: typeof analyze = (input) => {
      const a = analyze(input);
      const line = Buffer.byteLength(JSON.stringify(a)) + 1;
      // Pad a display name so the printed line is exactly one byte over the bound.
      a.files[0]!.mainAuthor = 'x'.repeat(
        MAX_ANALYSIS_BYTES - line + 1 + (a.files[0]!.mainAuthor?.length ?? 0),
      );
      return a;
    };
    const over = await run(good(f.sha, sizes), f.url, { analyzeFn: oversize });
    expect(over.code).toBe(1);
    expect(over.lines.at(-1)).toBe('{"error":"invalid_output"}');
    const exact: typeof analyze = (input) => {
      const a = analyze(input);
      const line = Buffer.byteLength(JSON.stringify(a)) + 1;
      a.files[0]!.mainAuthor = 'x'.repeat(
        MAX_ANALYSIS_BYTES - line + (a.files[0]!.mainAuthor?.length ?? 0),
      );
      return a;
    };
    const ok = await run(good(f.sha, sizes), f.url, { analyzeFn: exact });
    expect(ok.code).toBe(0);
    expect(Buffer.byteLength(ok.lines.at(-1)! + '\n')).toBe(MAX_ANALYSIS_BYTES);
  });
});

describe('job argument validation', () => {
  const SHA = 'a'.repeat(40);
  async function bad(argv: string[]) {
    const lines: string[] = [];
    const calls: string[][] = [];
    const code = await runJob(argv, {
      exec: (a) => {
        calls.push(a);
        return '';
      },
      write: (l) => lines.push(l),
    });
    return { code, lines, calls };
  }

  it.each([
    ['owner starting with -', ['--', '-x', 'demo', SHA, 'main', String(WINDOW), 's']],
    [
      'owner with shell metacharacters',
      ['--', 'o;rm -rf', 'demo', SHA, 'main', String(WINDOW), 's'],
    ],
    [
      'repo --upload-pack',
      ['--', 'octo', '--upload-pack=touch x', SHA, 'main', String(WINDOW), 's'],
    ],
    ['short head sha', ['--', 'octo', 'demo', 'abc123', 'main', String(WINDOW), 's']],
    ['upper-case head sha', ['--', 'octo', 'demo', 'A'.repeat(40), 'main', String(WINDOW), 's']],
    ['option-like head sha', ['--', 'octo', 'demo', '--all', 'main', String(WINDOW), 's']],
    ['non-integer window', ['--', 'octo', 'demo', SHA, 'main', '1700000000.5', 's']],
    ['negative window', ['--', 'octo', 'demo', SHA, 'main', '-5', 's']],
    ['window below 2000', ['--', 'octo', 'demo', SHA, 'main', '100', 's']],
    ['window above 2100', ['--', 'octo', 'demo', SHA, 'main', '99999999999', 's']],
    ['window as hex or text', ['--', 'octo', 'demo', SHA, 'main', '0x65000000', 's']],
    ['branch starting with -', ['--', 'octo', 'demo', SHA, '--x', String(WINDOW), 's']],
    ['missing --', ['octo', 'demo', SHA, 'main', String(WINDOW), 's', 'x']],
    ['too few args', ['--', 'octo', 'demo']],
    ['too many args', ['--', 'octo', 'demo', SHA, 'main', String(WINDOW), 's', 'extra']],
  ])('exits non-zero with bad_argument and runs no git for %s', async (_n, argv) => {
    const r = await bad(argv);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(['{"error":"bad_argument"}\n']);
    expect(r.calls).toHaveLength(0);
  });

  it('rejects an unreadable or malformed sizes file', async () => {
    const r = await bad([
      '--',
      'octo',
      'demo',
      SHA,
      'main',
      String(WINDOW),
      join(tmpdir(), 'nope.json'),
    ]);
    expect(r.lines).toEqual(['{"error":"bad_argument"}\n']);
    const p = await sizesFile([{ path: 'a', size: -1 }]);
    const r2 = await bad(['--', 'octo', 'demo', SHA, 'main', String(WINDOW), p]);
    expect(r2.lines).toEqual(['{"error":"bad_argument"}\n']);
  });
});

describe('job bundle', () => {
  it('bundles to one file that runs under node and rejects bad arguments', async () => {
    const esbuild = await import('esbuild');
    const dir = mkdtempSync(join(tmpdir(), 'cc-bundle-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const out = join(dir, 'job.mjs');
    await esbuild.build({
      entryPoints: ['lib/sandbox/job.ts'],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile: out,
      logLevel: 'silent',
    });
    let stdout = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [out, '--', '-x', 'y', 'z', 'main', '1', 's'], {
        encoding: 'utf8',
      });
    } catch (e) {
      const err = e as { stdout: string; status: number };
      stdout = err.stdout;
      status = err.status;
    }
    expect(status).toBe(1);
    expect(stdout).toBe('{"error":"bad_argument"}\n');
  });
});
