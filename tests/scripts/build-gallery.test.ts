import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';
import { CAPS } from '@/lib/caps';
import { GitHubError, type RepoFacts } from '@/lib/repo/github';
import {
  analyseLocally,
  buildGallery,
  galleryFileName,
  parseGalleryList,
  runBuiltJob,
} from '@/scripts/build-gallery';

const SHA = 'b'.repeat(40);
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-gallery-'));
  dirs.push(d);
  return d;
};

function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    owner: 'Owner',
    name: 'Repo',
    sizeKb: 10,
    totalCommits: 10,
    latestCommitUnix: 1_700_000_000,
    windowFromUnix: 1_600_000_000,
    headSha: SHA,
    defaultBranch: 'main',
    tree: [{ path: 'a.ts', size: 3 }],
    treeTruncated: false,
    ...over,
  };
}

const fakeAnalysis = (f: RepoFacts) =>
  ({
    schemaVersion: SCHEMA_VERSION,
    repo: { owner: f.owner, name: f.name, headSha: f.headSha, defaultBranch: f.defaultBranch },
  }) as unknown as Analysis;

describe('galleryFileName', () => {
  it('is <owner>__<repo>.json', () => {
    expect(galleryFileName('Owner', 'Repo')).toBe('Owner__Repo.json');
  });
});

describe('parseGalleryList', () => {
  it('parses each entry with the strict repo parser', () => {
    expect(parseGalleryList(['o/r', 'https://github.com/O/R.git'])).toEqual([
      { owner: 'o', name: 'r' },
      { owner: 'O', name: 'R' },
    ]);
  });
  it('throws on an invalid entry or a non-array', () => {
    expect(() => parseGalleryList(['o/r;x'])).toThrow();
    expect(() => parseGalleryList({} as unknown)).toThrow();
    expect(() => parseGalleryList([1] as unknown)).toThrow();
  });
});

describe('buildGallery', () => {
  it('calls fetchRepoFacts (not its own trees request), analyses and writes the expected file', async () => {
    const outDir = tmp();
    const fetchFacts = vi.fn(async () => facts());
    const analyse = vi.fn(async (f: RepoFacts) => fakeAnalysis(f));
    const res = await buildGallery([{ owner: 'owner', name: 'repo' }], {
      fetchFacts,
      analyse,
      outDir,
    });
    expect(fetchFacts).toHaveBeenCalledWith('owner', 'repo');
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(readdirSync(outDir)).toEqual(['Owner__Repo.json']);
    const written = JSON.parse(readFileSync(join(outDir, 'Owner__Repo.json'), 'utf8'));
    expect(written.schemaVersion).toBe(SCHEMA_VERSION);
    expect(res).toEqual({ written: ['Owner__Repo.json'], failed: [] });
  });

  it('refuses a truncated tree and an over-cap repo before any clone', async () => {
    const outDir = tmp();
    const analyse = vi.fn(async (f: RepoFacts) => fakeAnalysis(f));
    const bigTree = Array.from({ length: CAPS.maxFiles + 1 }, (_, i) => ({
      path: `f${i}`,
      size: 1,
    }));
    const cases: [RepoFacts, string][] = [
      [facts({ treeTruncated: true }), 'tree_truncated'],
      [facts({ sizeKb: CAPS.maxSizeKb + 1 }), 'repo_too_large'],
      [facts({ totalCommits: CAPS.maxTotalCommits + 1 }), 'too_many_commits'],
      [facts({ tree: bigTree }), 'too_many_files'],
    ];
    for (const [f, code] of cases) {
      const res = await buildGallery([{ owner: 'owner', name: 'repo' }], {
        fetchFacts: async () => f,
        analyse,
        outDir,
      });
      expect(res.failed).toEqual([{ repo: 'owner/repo', code }]);
      expect(res.written).toEqual([]);
    }
    expect(analyse).not.toHaveBeenCalled();
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('records a GitHub error code and carries on with the next repo', async () => {
    const outDir = tmp();
    const fetchFacts = vi.fn(async (o: string) => {
      if (o === 'bad') throw new GitHubError('not_found');
      return facts({ owner: o, name: 'repo' });
    });
    const res = await buildGallery(
      [
        { owner: 'bad', name: 'repo' },
        { owner: 'good', name: 'repo' },
      ],
      { fetchFacts, analyse: async (f) => fakeAnalysis(f), outDir },
    );
    expect(res.failed).toEqual([{ repo: 'bad/repo', code: 'not_found' }]);
    expect(res.written).toEqual(['good__repo.json']);
  });

  it('does not write a result whose repo fields disagree with the facts', async () => {
    const outDir = tmp();
    const res = await buildGallery([{ owner: 'owner', name: 'repo' }], {
      fetchFacts: async () => facts(),
      analyse: async (f) => ({
        ...fakeAnalysis(f),
        repo: { ...fakeAnalysis(f).repo, headSha: 'c'.repeat(40) },
      }),
      outDir,
    });
    expect(res.failed).toEqual([{ repo: 'owner/repo', code: 'invalid_output' }]);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('never puts a thrown error message in the result', async () => {
    const outDir = tmp();
    const res = await buildGallery([{ owner: 'o', name: 'r' }], {
      fetchFacts: async () => {
        throw new Error('token ghp_SECRET leaked in message');
      },
      analyse: async (f) => fakeAnalysis(f),
      outDir,
    });
    expect(JSON.stringify(res)).not.toContain('ghp_SECRET');
    expect(res.failed).toEqual([{ repo: 'o/r', code: 'internal_error' }]);
  });
});

describe('analyseLocally', () => {
  it('runs the job with validated arguments and returns the Analysis line', async () => {
    const f = facts();
    const calls: string[][] = [];
    const runJobFn = vi.fn(async (argv: string[], deps: { write?: (l: string) => void }) => {
      calls.push(argv);
      // the sizes file holds the tree, including .mailmap when present
      const sizes = JSON.parse(readFileSync(argv[6]!, 'utf8'));
      expect(sizes).toEqual(f.tree);
      deps.write?.('{"phase":"cloning"}\n');
      deps.write?.(`${JSON.stringify(fakeAnalysis(f))}\n`);
      return 0;
    });
    const a = await analyseLocally(f, { runJobFn, parse: (x) => x as Analysis });
    expect(a.repo.headSha).toBe(SHA);
    expect(calls[0]!.slice(0, 6)).toEqual([
      '--',
      'Owner',
      'Repo',
      SHA,
      'main',
      String(f.windowFromUnix),
    ]);
  });

  it('turns a job error line into an Error carrying the code only', async () => {
    const runJobFn = async (_a: string[], deps: { write?: (l: string) => void }) => {
      deps.write?.('{"error":"stale_head"}\n');
      return 1;
    };
    await expect(analyseLocally(facts(), { runJobFn })).rejects.toMatchObject({
      message: 'stale_head',
    });
  });

  it('treats unparseable job output as invalid_output', async () => {
    const runJobFn = async (_a: string[], deps: { write?: (l: string) => void }) => {
      deps.write?.('not json\n');
      return 0;
    };
    await expect(analyseLocally(facts(), { runJobFn })).rejects.toMatchObject({
      message: 'invalid_output',
    });
  });
});

describe('committed gallery files', () => {
  it('have the current schemaVersion (passes trivially with zero files)', () => {
    const dir = join(process.cwd(), 'public', 'gallery');
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      expect({ file: f, v: parsed.schemaVersion }).toEqual({ file: f, v: SCHEMA_VERSION });
    }
  });

  it('scripts/gallery.json is a list of valid repo entries', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'gallery.json'), 'utf8'));
    expect(() => parseGalleryList(raw)).not.toThrow();
  });
});

describe('runBuiltJob', () => {
  const script = (body: string) => {
    const p = join(tmp(), 'fake-job.mjs');
    writeFileSync(p, body);
    return p;
  };

  it('decodes a multi-byte character split across stdout chunks intact', async () => {
    const bundle = script(`
      const buf = Buffer.from('{"p":"' + 'é'.repeat(5) + '"}' + String.fromCharCode(10), 'utf8');
      process.stdout.write(buf.subarray(0, 7)); // splits the first é in half
      setTimeout(() => process.stdout.write(buf.subarray(7)), 50);
    `);
    let out = '';
    const code = await runBuiltJob(['--'], { write: (l) => (out += l) }, { bundle });
    expect(code).toBe(0);
    expect(out).toBe('{"p":"ééééé"}' + String.fromCharCode(10));
    expect(out).not.toContain(String.fromCharCode(0xfffd));
  });

  it('kills a hung job after the timeout', async () => {
    const bundle = script('setInterval(() => {}, 1000);');
    const code = await runBuiltJob(['--'], {}, { bundle, timeoutMs: 300 });
    expect(code).not.toBe(0);
  });
});
