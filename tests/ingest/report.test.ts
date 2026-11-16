import { describe, expect, it } from 'vitest';
import type { AuthorShare, FileStat } from '../../lib/analysis/types';
import {
  IGNORED_FOR_REPORT,
  buildReport,
  hotspotScore,
  singleOwnerDistricts,
} from '../../lib/ingest/report';

function file(path: string, over: Partial<FileStat> = {}): FileStat {
  return {
    path,
    size: 100,
    language: 'Other',
    changes: 0,
    lastChanged: null,
    bugFixes: 0,
    authors: [],
    mainAuthor: null,
    mainAuthorShare: 0,
    coChange: [],
    ...over,
  };
}
const author = (key: string, name: string, share: number): AuthorShare => ({ key, name, share });
const owned = (path: string, changes: number, authors: AuthorShare[]) =>
  file(path, {
    changes,
    lastChanged: 1_700_000_000,
    authors,
    mainAuthor: authors[0]?.name ?? null,
    mainAuthorShare: authors[0]?.share ?? 0,
  });

describe('hotspotScore', () => {
  it('is the percentile rank of changes times the percentile rank of size, 0 to 1', () => {
    const files = [
      file('a.ts', { changes: 1, size: 10 }),
      file('b.ts', { changes: 5, size: 50 }),
      file('c.ts', { changes: 9, size: 90 }),
    ];
    const score = hotspotScore(files);
    expect(score.get('a.ts')).toBe(0);
    expect(score.get('b.ts')).toBeCloseTo(0.25);
    expect(score.get('c.ts')).toBe(1);
  });

  it('gives every file a finite score in [0, 1] when everything ties', () => {
    const files = [1, 2, 3, 4].map((i) => file(`f${i}.ts`, { changes: 3, size: 100 }));
    for (const v of hotspotScore(files).values()) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(new Set(hotspotScore(files).values()).size).toBe(1);
  });

  it('handles a single file and an empty list', () => {
    expect(hotspotScore([file('a.ts', { changes: 2 })]).get('a.ts')).toBe(0);
    expect(hotspotScore([]).size).toBe(0);
  });

  it('scores a file with no changes in the window as 0', () => {
    const files = [
      file('cold.ts', { changes: 0, size: 999 }),
      file('hot.ts', { changes: 4, size: 5 }),
    ];
    expect(hotspotScore(files).get('cold.ts')).toBe(0);
  });
});

describe('buildReport', () => {
  it('returns empty lists for an empty file list', () => {
    expect(buildReport([])).toEqual({ readFirst: [], riskiest: [], forgotten: [] });
  });

  it('never lists lockfiles, minified files, dist, vendor or images, even when they top the raw score', () => {
    const noisy = [
      'package-lock.json',
      'web/package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'public/app.min.js',
      'dist/bundle.js',
      'packages/x/dist/index.js',
      'vendor/lib/x.go',
      'assets/logo.png',
      'assets/photo.JPG',
    ];
    const files = [
      ...noisy.map((p) =>
        file(p, {
          changes: 100,
          size: 1_000_000,
          bugFixes: 90,
          lastChanged: 1_700_000_000,
          authors: [author('k1', 'Ada', 1), author('k2', 'Bo', 0)],
          coChange: [{ path: 'src/a.ts', shared: 5, score: 0.5 }],
        }),
      ),
      owned('src/a.ts', 5, [author('k1', 'Ada', 1)]),
      file('src/old.ts', { size: 500 }),
      file('src/tiny.ts', { size: 1 }),
    ];
    files[files.length - 3] = { ...files[files.length - 3]!, bugFixes: 3 };
    const report = buildReport(files);
    const listed = [...report.readFirst, ...report.riskiest, ...report.forgotten];
    for (const p of noisy) expect(listed).not.toContain(p);
    expect(report.readFirst).toContain('src/a.ts');
    expect(report.riskiest).toContain('src/a.ts');
    expect(report.forgotten).toContain('src/old.ts');
  });

  it('exposes an ignore list covering the plan-level patterns', () => {
    const hit = (p: string) => IGNORED_FOR_REPORT.some((re) => re.test(p));
    expect(hit('package-lock.json')).toBe(true);
    expect(hit('a/b/c.min.js')).toBe(true);
    expect(hit('dist/x.js')).toBe(true);
    expect(hit('vendor/x.js')).toBe(true);
    expect(hit('src/distance.ts')).toBe(false);
    expect(hit('src/vendors.ts')).toBe(false);
    expect(hit('src/app.ts')).toBe(false);
  });

  it('readFirst weights changes 0.5, co-change degree 0.3 and distinct authors 0.2', () => {
    const co = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `x${i}.ts`, shared: 3, score: 0.5 }));
    const au = (n: number) => Array.from({ length: n }, (_, i) => author(`k${i}`, `A${i}`, 1 / n));
    // churn: most changes only; degree: most co-change only; authors: most authors only.
    const a = owned('churn.ts', 30, au(1));
    const b = { ...owned('degree.ts', 20, au(1)), coChange: co(5) };
    const c = owned('authors.ts', 10, au(5));
    const d = owned('plain.ts', 1, au(1));
    const report = buildReport([d, c, b, a]);
    // scores: degree .5*.67+.3*1+.2*.33=.70, churn .5*1+.3*.33+.2*.33=.67, authors .5*.33+.3*.33+.2*1=.47, plain .2
    expect(report.readFirst).toEqual(['degree.ts', 'churn.ts', 'authors.ts', 'plain.ts']);
  });

  it('readFirst leaves out files with no change in the window and breaks ties by size then path', () => {
    const files = [
      owned('b.ts', 3, [author('k', 'Ada', 1)]),
      owned('a.ts', 3, [author('k', 'Ada', 1)]),
      { ...owned('big.ts', 3, [author('k', 'Ada', 1)]), size: 900 },
      file('cold.ts', { size: 5000 }),
    ];
    expect(buildReport(files).readFirst).toEqual(['big.ts', 'a.ts', 'b.ts']);
  });

  it('riskiest excludes files under 3 changes and ranks hotspot times bug-fix density', () => {
    const files = [
      owned('two.ts', 2, [author('k', 'Ada', 1)]),
      owned('risky.ts', 10, [author('k', 'Ada', 1)]),
      owned('clean.ts', 12, [author('k', 'Ada', 1)]),
      owned('mid.ts', 6, [author('k', 'Ada', 1)]),
    ];
    files[0] = { ...files[0]!, bugFixes: 2, size: 1000 };
    files[1] = { ...files[1]!, bugFixes: 8, size: 400 };
    files[3] = { ...files[3]!, bugFixes: 1, size: 200 };
    const { riskiest } = buildReport(files);
    expect(riskiest).not.toContain('two.ts');
    expect(riskiest).not.toContain('clean.ts'); // zero bug fixes, zero risk
    expect(riskiest[0]).toBe('risky.ts');
  });

  it('forgotten lists cold files above the median size by size, then the oldest in-window files', () => {
    const files = [
      file('cold-big.ts', { size: 900 }),
      file('cold-bigger.ts', { size: 1000 }),
      file('cold-small.ts', { size: 1 }),
      { ...owned('old.ts', 2, [author('k', 'Ada', 1)]), size: 800, lastChanged: 1_000 },
      { ...owned('newer.ts', 2, [author('k', 'Ada', 1)]), size: 700, lastChanged: 2_000 },
      { ...owned('small-live.ts', 2, [author('k', 'Ada', 1)]), size: 2, lastChanged: 500 },
    ];
    // sizes sorted: 1, 2, 700, 800, 900, 1000 -> median 750
    expect(buildReport(files).forgotten).toEqual(['cold-bigger.ts', 'cold-big.ts', 'old.ts']);
  });

  it('forgotten breaks ties by size then path and does not pad', () => {
    const files = [
      file('z.ts', { size: 50 }),
      file('a.ts', { size: 50 }),
      file('tiny.ts', { size: 1 }),
      file('tiny2.ts', { size: 1 }),
    ];
    expect(buildReport(files).forgotten).toEqual(['a.ts', 'z.ts']);
  });

  it('caps every list at 10 and does not pad lists with fewer candidates', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      file(`f${String(i).padStart(2, '0')}.ts`, { size: 100 + i }),
    );
    const report = buildReport(many);
    expect(report.forgotten).toHaveLength(10);
    expect(report.readFirst).toEqual([]);
    expect(report.riskiest).toEqual([]);
  });

  it('is deterministic and independent of input order, with all values tied', () => {
    const tied = Array.from({ length: 12 }, (_, i) =>
      owned(`t${String(i).padStart(2, '0')}.ts`, 4, [author('k', 'Ada', 1)]),
    );
    const a = buildReport(tied);
    const b = buildReport([...tied].reverse());
    expect(b).toEqual(a);
    expect(a.readFirst).toHaveLength(10);
    expect(a.readFirst[0]).toBe('t00.ts');
  });
});

describe('singleOwnerDistricts', () => {
  const ada = author('aaaaaaaaaaaa', 'Ada', 1);

  it('lists folders at depth 1 and 2 only', () => {
    const files = [
      owned('root.ts', 1, [ada]),
      owned('src/a.ts', 1, [ada]),
      owned('src/lib/b.ts', 1, [ada]),
      owned('src/lib/deep/c.ts', 1, [ada]),
    ];
    expect(singleOwnerDistricts(files).map((d) => d.path)).toEqual(['src', 'src/lib']);
  });

  it('flags a single owner at exactly 80% and 5 changes, with key, name and share', () => {
    const bo = author('bbbbbbbbbbbb', 'Bo', 0.2);
    const files = [owned('pkg/a.ts', 5, [author('aaaaaaaaaaaa', 'Ada', 0.8), bo])];
    const [d] = singleOwnerDistricts(files);
    expect(d).toEqual({
      path: 'pkg',
      singleOwner: true,
      ownerKey: 'aaaaaaaaaaaa',
      ownerName: 'Ada',
      ownerShare: 0.8,
      changes: 5,
    });
  });

  it('does not flag at 79% or at 4 changes but still lists the district', () => {
    const at79 = [
      owned('p/a.ts', 100, [author('aaaaaaaaaaaa', 'Ada', 0.79), author('b', 'Bo', 0.21)]),
    ];
    const d79 = singleOwnerDistricts(at79)[0]!;
    expect(d79.singleOwner).toBe(false);
    expect(d79.ownerKey).toBe('aaaaaaaaaaaa');
    expect(d79.ownerShare).toBeCloseTo(0.79);
    const few = singleOwnerDistricts([owned('q/a.ts', 4, [ada])])[0]!;
    expect(few.singleOwner).toBe(false);
    expect(few.ownerShare).toBe(1);
    expect(few.changes).toBe(4);
  });

  it('sums touches across files beneath the district, weighting share by changes', () => {
    const files = [
      owned('d/a.ts', 8, [author('aaaaaaaaaaaa', 'Ada', 1)]),
      owned('d/sub/b.ts', 2, [author('bbbbbbbbbbbb', 'Bo', 1)]),
    ];
    const byPath = new Map(singleOwnerDistricts(files).map((d) => [d.path, d]));
    expect(byPath.get('d')).toMatchObject({
      changes: 10,
      singleOwner: true,
      ownerKey: 'aaaaaaaaaaaa',
      ownerShare: 0.8,
    });
    expect(byPath.get('d/sub')).toMatchObject({
      changes: 2,
      ownerKey: 'bbbbbbbbbbbb',
      singleOwner: false,
    });
  });

  it('has null owner fields and share 0 when there is no author, and never divides by zero', () => {
    const files = [file('cold/a.ts'), file('cold/b.ts')];
    expect(singleOwnerDistricts(files)).toEqual([
      {
        path: 'cold',
        singleOwner: false,
        ownerKey: null,
        ownerName: null,
        ownerShare: 0,
        changes: 0,
      },
    ]);
  });

  it('counts ignored files too (the ignore list is for the report only)', () => {
    const files = [owned('dist/x.js', 6, [ada])];
    expect(singleOwnerDistricts(files)[0]).toMatchObject({ path: 'dist', singleOwner: true });
  });

  it('returns districts sorted by path, independent of input order, and an empty list for no files', () => {
    const files = [
      owned('b/x.ts', 1, [ada]),
      owned('a/x.ts', 1, [ada]),
      owned('a/y/z.ts', 1, [ada]),
    ];
    const forward = singleOwnerDistricts(files);
    expect(forward.map((d) => d.path)).toEqual(['a', 'a/y', 'b']);
    expect(singleOwnerDistricts([...files].reverse())).toEqual(forward);
    expect(singleOwnerDistricts([])).toEqual([]);
  });
});
