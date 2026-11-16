import { describe, expect, it } from 'vitest';
import { CAPS } from '@/lib/caps';
import { SCHEMA_VERSION, analysisSchema, parseAnalysis } from '@/lib/analysis/schema';
import type { Analysis, FileStat } from '@/lib/analysis/types';

function file(over: Partial<FileStat> = {}): FileStat {
  return {
    path: 'src/index.ts',
    size: 120,
    language: 'TypeScript',
    changes: 4,
    lastChanged: 1_700_000_000,
    bugFixes: 1,
    authors: [{ key: '000000000001', name: 'Ada Lovelace', share: 1 }],
    mainAuthor: '000000000001',
    mainAuthorShare: 1,
    coChange: [{ path: 'src/util.ts', shared: 3, score: 0.5 }],
    ...over,
  };
}

function sample(over: Partial<Analysis> = {}): Analysis {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: { owner: 'o', name: 'r', headSha: 'a'.repeat(40), defaultBranch: 'main' },
    window: { from: 1_650_000_000, to: 1_710_000_000, commits: 10 },
    stats: {
      bugFixCommitShare: 0.1,
      botCommitsExcluded: 0,
      commitsInWindow: 10,
      thinHistory: true,
      mailmapApplied: false,
      capsHit: [],
    },
    files: [file()],
    districts: [
      {
        path: 'src',
        singleOwner: true,
        ownerKey: '000000000001',
        ownerName: 'Ada Lovelace',
        ownerShare: 1,
        changes: 5,
      },
    ],
    report: { readFirst: ['src/index.ts'], riskiest: [], forgotten: [] },
    ...over,
  };
}

// Deep-clone helper so each test mutates its own copy.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// Hostile-input tests mutate arbitrary paths of the sample, so the loose type is deliberate.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

function rejects(mutate: (a: Loose) => void): void {
  const a = clone(sample()) as unknown as Loose;
  mutate(a);
  expect(() => parseAnalysis(a)).toThrow();
}

describe('parseAnalysis', () => {
  it('parses a valid sample', () => {
    expect(parseAnalysis(clone(sample()))).toEqual(sample());
  });

  it('accepts lastChanged null (older than window)', () => {
    const a = sample({
      files: [file({ lastChanged: null, changes: 0, mainAuthor: null, authors: [] })],
    });
    expect(() => parseAnalysis(clone(a))).not.toThrow();
  });

  it('accepts an empty history', () => {
    const a = sample({ files: [], districts: [] });
    expect(() => parseAnalysis(clone(a))).not.toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => parseAnalysis(null)).toThrow();
    expect(() => parseAnalysis('x')).toThrow();
  });

  it('rejects a missing schemaVersion or a different one', () => {
    rejects((a) => delete a.schemaVersion);
    rejects((a) => (a.schemaVersion = SCHEMA_VERSION + 1));
  });

  it('rejects an author key that is not 12 hex characters (an email, upper-case, wrong length)', () => {
    for (const key of [
      'ada@example.com',
      'ABCDEF012345',
      'abcdef01234',
      '0000000000016',
      'abcdef01234g',
    ]) {
      rejects((a) => (a.files[0].authors[0].key = key));
    }
  });

  it('rejects an author name containing @', () => {
    rejects((a) => (a.files[0].authors[0].name = 'ada@example.com'));
  });

  it('rejects an author name over 200 characters and accepts exactly 200', () => {
    rejects((a) => (a.files[0].authors[0].name = 'x'.repeat(201)));
    const ok = clone(sample());
    ok.files[0]!.authors[0]!.name = 'x'.repeat(200);
    expect(() => parseAnalysis(ok)).not.toThrow();
  });

  it('rejects an unknown field such as an email (no author email anywhere)', () => {
    rejects((a) => (a.files[0].authors[0].email = 'ada@example.com'));
    rejects((a) => (a.files[0].email = 'ada@example.com'));
    rejects((a) => (a.extra = 1));
  });

  it('rejects a district ownerName containing @', () => {
    rejects((a) => (a.districts[0].ownerName = 'ada@example.com'));
  });

  it('rejects negative size and negative changes', () => {
    rejects((a) => (a.files[0].size = -1));
    rejects((a) => (a.files[0].changes = -1));
  });

  it('rejects non-finite and non-integer numbers where integers are required', () => {
    rejects((a) => (a.files[0].size = 1.5));
    rejects((a) => (a.files[0].changes = 'many'));
    rejects((a) => (a.files[0].authors[0].share = 2));
    rejects((a) => (a.files[0].mainAuthorShare = -0.1));
  });

  it('rejects more than 5 co-changes and accepts 5', () => {
    const cc = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `p${i}`, shared: 3, score: 0.4 }));
    rejects((a) => (a.files[0].coChange = cc(6)));
    const ok = clone(sample());
    ok.files[0]!.coChange = cc(5);
    expect(() => parseAnalysis(ok)).not.toThrow();
  });

  it('rejects 6 authors on one file', () => {
    rejects((a) => {
      a.files[0].authors = Array.from({ length: 6 }, (_, i) => ({
        key: `abcdef01234${i}`,
        name: `n${i}`,
        share: 0.1,
      }));
    });
  });

  it('rejects 10,001 files and accepts 10,000', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => file({ path: `f${i}`, coChange: [] }));
    expect(() => parseAnalysis(clone(sample({ files: many(CAPS.maxFiles) })))).not.toThrow();
    expect(() => parseAnalysis(clone(sample({ files: many(CAPS.maxFiles + 1) })))).toThrow();
  });

  it('rejects a 1,025-character path (also inside co-change and report) and accepts 1,024', () => {
    rejects((a) => (a.files[0].path = 'x'.repeat(1025)));
    rejects((a) => (a.files[0].coChange[0].path = 'x'.repeat(1025)));
    rejects((a) => (a.report.readFirst = ['x'.repeat(1025)]));
    rejects((a) => (a.districts[0].path = 'x'.repeat(1025)));
    const ok = clone(sample());
    ok.files[0]!.path = 'x'.repeat(1024);
    expect(() => parseAnalysis(ok)).not.toThrow();
  });

  it('rejects an empty path', () => {
    rejects((a) => (a.files[0].path = ''));
  });

  it('rejects report lists longer than 10', () => {
    for (const k of ['readFirst', 'riskiest', 'forgotten']) {
      rejects((a) => (a.report[k] = Array.from({ length: 11 }, (_, i) => `f${i}`)));
    }
  });

  it('rejects a missing report list', () => {
    rejects((a) => delete a.report.forgotten);
    rejects((a) => delete a.report);
  });

  it('rejects stats missing any of its six fields', () => {
    for (const k of [
      'bugFixCommitShare',
      'botCommitsExcluded',
      'commitsInWindow',
      'thinHistory',
      'mailmapApplied',
      'capsHit',
    ]) {
      rejects((a) => delete a.stats[k]);
    }
  });

  it('rejects a missing repo.headSha, a malformed one, and a missing repo field', () => {
    rejects((a) => delete a.repo.headSha);
    rejects((a) => (a.repo.headSha = 'abc'));
    rejects((a) => delete a.repo.defaultBranch);
  });

  it('rejects a window with a non-numeric from or to', () => {
    rejects((a) => (a.window.from = 'yesterday'));
    rejects((a) => (a.window.to = '2026-01-01'));
    rejects((a) => (a.window.from = null));
    rejects((a) => delete a.window.commits);
  });

  it('rejects 2,001 districts, accepts 2,000, and rejects a district missing singleOwner', () => {
    const d = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `d${i}`,
        singleOwner: false,
        ownerKey: null,
        ownerName: null,
        ownerShare: 0,
        changes: 0,
      }));
    expect(() => parseAnalysis(clone(sample({ districts: d(2000) })))).not.toThrow();
    expect(() => parseAnalysis(clone(sample({ districts: d(2001) })))).toThrow();
    rejects((a) => delete a.districts[0].singleOwner);
    rejects((a) => (a.districts[0].ownerShare = 1.2));
  });

  it('rejects a sample whose serialised size exceeds 8 MB (maximal paths and co-changes)', () => {
    const longPath = (n: number) => `${'d'.repeat(1000)}${String(n).padStart(24, '0')}`;
    const files = Array.from({ length: CAPS.maxFiles }, (_, i) =>
      file({
        path: longPath(i),
        coChange: Array.from({ length: 5 }, (_, j) => ({
          path: longPath(j),
          shared: 3,
          score: 0.5,
        })),
      }),
    );
    const big = sample({ files });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(CAPS.maxStdoutBytes);
    expect(() => parseAnalysis(big)).toThrow();
    expect(analysisSchema.safeParse(big).success).toBe(false);
  });

  it('counts size in bytes, not characters (multi-byte paths)', () => {
    // 1,024 chars x 3 bytes: each path is within the character cap but the total is over 8 MB.
    const files = Array.from({ length: 3000 }, (_, i) =>
      file({ path: `${'€'.repeat(1000)}${i}`, coChange: [] }),
    );
    const big = sample({ files });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(CAPS.maxStdoutBytes);
    expect(() => parseAnalysis(big)).toThrow();
  });
});

describe('CAPS', () => {
  it('has the starting values', () => {
    expect(CAPS.maxSizeKb).toBe(1_048_576);
    expect(CAPS.maxTotalCommits).toBe(50_000);
    expect(CAPS.maxCommitsInWindow).toBe(20_000);
    expect(CAPS.maxFiles).toBe(10_000);
    expect(CAPS.analysisDeadlineMs).toBe(240_000);
    expect(CAPS.maxStdoutBytes).toBe(8_388_608);
  });
});
