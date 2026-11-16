import { describe, expect, it } from 'vitest';
import {
  authorKey,
  computeFileStats,
  isBot,
  isBugFix,
  languageOf,
  normaliseEmail,
  scrubName,
} from '../../lib/ingest/metrics';
import type { Commit } from '../../lib/ingest/parseLog';
import { parseAnalysis } from '../../lib/analysis/schema';

describe('isBugFix', () => {
  it.each([
    'Fix crash on empty input',
    'fixes #12',
    'hotfix: login',
    'Fixed the parser',
    'Regression in export',
  ])('matches %j', (s) => expect(isBugFix(s)).toBe(true));
  it.each([
    'fix typo in README',
    'lint fixes',
    'docs: fix link',
    'doc: fix link',
    'prefix handling',
    'fix whitespace',
    'format and fix',
    'add feature',
    '',
  ])('rejects %j', (s) => expect(isBugFix(s)).toBe(false));
});

describe('normaliseEmail and authorKey', () => {
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Jane@X.com ')).toBe('jane@x.com');
  });
  it('reduces the GitHub noreply form', () => {
    expect(normaliseEmail('123+jane@users.noreply.github.com')).toBe(
      'jane@users.noreply.github.com',
    );
    expect(normaliseEmail('jane@users.noreply.github.com')).toBe('jane@users.noreply.github.com');
  });
  it('gives a 12-hex key, case-insensitive, never containing the email', () => {
    const k = authorKey('Jane@X.com');
    expect(k).toMatch(/^[0-9a-f]{12}$/);
    expect(authorKey('jane@x.com')).toBe(k);
    expect(k).not.toContain('jane');
    expect(authorKey('99+jane@users.noreply.github.com')).toBe(
      authorKey('jane@users.noreply.github.com'),
    );
  });
});

describe('isBot', () => {
  it.each([
    ['dependabot[bot]', 'x@y.test'],
    ['renovate', 'x@y.test'],
    ['Renovate Bot', 'x@y.test'],
    ['github-actions[bot]', 'x@y.test'],
    ['Someone', '49699333+dependabot[bot]@users.noreply.github.com'],
  ])('true for %s <%s>', (n, e) => expect(isBot(n, e)).toBe(true));
  it('false for a human', () => {
    expect(isBot('Jane Doe', 'jane@example.test')).toBe(false);
  });
});

describe('scrubName', () => {
  it('cuts at the first @', () => {
    expect(scrubName('jane@example.com')).toBe('jane');
    expect(scrubName('Jane Doe <jane@example.com>')).toBe('Jane Doe <jane');
  });
  it('leaves a plain name alone', () => {
    expect(scrubName('jane')).toBe('jane');
    expect(scrubName('Jane Doe')).toBe('Jane Doe');
  });
  it('falls back when nothing is left', () => {
    expect(scrubName('@handle')).toBe('unknown');
    expect(scrubName('   ')).toBe('unknown');
  });
  it('truncates to 200 characters', () => {
    expect(scrubName('a'.repeat(300))).toHaveLength(200);
  });
});

describe('languageOf', () => {
  it.each([
    ['src/a.ts', 'TypeScript'],
    ['A.TSX', 'TypeScript'],
    ['x/y.py', 'Python'],
    ['main.go', 'Go'],
    ['README.md', 'Markdown'],
    ['Dockerfile', 'Dockerfile'],
    ['a/b/Makefile', 'Makefile'],
    ['LICENSE', 'Other'],
    ['weird.unknownext', 'Other'],
    ['.gitignore', 'Other'],
  ])('%s -> %s', (p, l) => expect(languageOf(p)).toBe(l));
});

const DAY = 86400;
const W = 1_000_000;
function c(over: Partial<Commit> & { files: string[] }): Commit {
  return {
    hash: 'a'.repeat(40),
    authorName: 'Ann',
    authorEmail: 'ann@example.test',
    time: W + DAY,
    subject: 'change',
    ...over,
  };
}
function find(stats: ReturnType<typeof computeFileStats>, path: string) {
  const f = stats.find((s) => s.path === path);
  if (!f) throw new Error(`no stat for ${path}`);
  return f;
}

describe('computeFileStats', () => {
  const head = [
    { path: 'a.ts', size: 100 },
    { path: 'b.ts', size: 50 },
    { path: 'cold.md', size: 10 },
  ];

  it('counts changes and bug fixes only inside the window and lists cold files', () => {
    const commits = [
      c({ time: W + 3 * DAY, subject: 'Fix crash', files: ['a.ts'] }),
      c({ time: W + 2 * DAY, subject: 'add thing', files: ['a.ts', 'b.ts'] }),
      c({ time: W - 1, subject: 'Fix old bug', files: ['a.ts', 'cold.md'] }),
    ];
    const stats = computeFileStats(commits, head, W);
    const a = find(stats, 'a.ts');
    expect(a.changes).toBe(2);
    expect(a.bugFixes).toBe(1);
    expect(a.lastChanged).toBe(W + 3 * DAY);
    const cold = find(stats, 'cold.md');
    expect(cold).toMatchObject({
      changes: 0,
      bugFixes: 0,
      lastChanged: null,
      mainAuthor: null,
      mainAuthorShare: 0,
      authors: [],
      coChange: [],
    });
    expect(stats).toHaveLength(3);
  });

  it('includes a commit exactly at the window start', () => {
    expect(find(computeFileStats([c({ time: W, files: ['a.ts'] })], head, W), 'a.ts').changes).toBe(
      1,
    );
  });

  it('ignores paths not at HEAD and counts a path listed twice in a commit once', () => {
    const stats = computeFileStats([c({ files: ['a.ts', 'a.ts', 'gone.ts'] })], head, W);
    expect(stats.map((s) => s.path)).toEqual(['a.ts', 'b.ts', 'cold.md']);
    expect(find(stats, 'a.ts').changes).toBe(1);
  });

  it('excludes bot commits entirely', () => {
    const commits = [
      c({ authorName: 'dependabot[bot]', authorEmail: 'bot@x.test', files: ['a.ts'] }),
      c({ files: ['a.ts'] }),
    ];
    const a = find(computeFileStats(commits, head, W), 'a.ts');
    expect(a.changes).toBe(1);
    expect(a.authors).toHaveLength(1);
    expect(a.mainAuthor).toBe('Ann');
  });

  it('ignores a bot commit outside the window and a bot matched by email only', () => {
    const commits = [
      c({ time: W - 5, authorName: 'renovate', authorEmail: 'r@x.test', files: ['a.ts'] }),
      c({
        authorName: 'Robo',
        authorEmail: '1+dependabot[bot]@users.noreply.github.com',
        files: ['a.ts'],
      }),
      c({ subject: 'Fix crash', files: ['a.ts'] }),
    ];
    const a = find(computeFileStats(commits, head, W), 'a.ts');
    expect(a).toMatchObject({ changes: 1, bugFixes: 1 });
    expect(a.authors).toHaveLength(1);
  });

  it('does not merge different authors that both have an empty email', () => {
    const commits = [
      c({ authorName: 'Ann', authorEmail: '', files: ['a.ts'] }),
      c({ authorName: 'Bob', authorEmail: '', files: ['a.ts'] }),
    ];
    const a = find(computeFileStats(commits, head, W), 'a.ts');
    expect(a.authors.map((x) => x.name).sort()).toEqual(['Ann', 'Bob']);
  });

  it('truncates a long name by code point without splitting a surrogate pair', () => {
    expect(scrubName('a'.repeat(199) + '😀😀')).toBe('a'.repeat(199) + '😀');
  });

  it('a file touched only by a bot is cold', () => {
    const a = find(
      computeFileStats(
        [c({ authorName: 'renovate', authorEmail: 'r@x.test', files: ['a.ts'] })],
        head,
        W,
      ),
      'a.ts',
    );
    expect(a).toMatchObject({ changes: 0, lastChanged: null, mainAuthor: null });
  });

  it('computes author shares, merging emails by key and ordering ties by key', () => {
    const commits = [
      c({ authorName: 'Ann', authorEmail: 'Ann@Example.test', files: ['a.ts'] }),
      c({ authorName: 'Ann', authorEmail: 'ann@example.test', files: ['a.ts'] }),
      c({ authorName: 'Bob', authorEmail: 'bob@example.test', files: ['a.ts'] }),
    ];
    const a = find(computeFileStats(commits, head, W), 'a.ts');
    expect(a.authors.map((x) => x.name)).toEqual(['Ann', 'Bob']);
    expect(a.authors[0]?.share).toBeCloseTo(2 / 3);
    expect(a.mainAuthor).toBe('Ann');
    expect(a.mainAuthorShare).toBeCloseTo(2 / 3);
  });

  it('breaks an exact tie between authors by key, stably regardless of commit order', () => {
    const x = c({ authorName: 'Ann', authorEmail: 'ann@example.test', files: ['a.ts'] });
    const y = c({ authorName: 'Bob', authorEmail: 'bob@example.test', files: ['a.ts'] });
    const one = find(computeFileStats([x, y], head, W), 'a.ts');
    const two = find(computeFileStats([y, x], head, W), 'a.ts');
    expect(one.authors).toEqual(two.authors);
    const keys = one.authors.map((a) => a.key);
    expect(keys).toEqual([...keys].sort());
  });

  it('keeps at most 5 authors', () => {
    const commits = Array.from({ length: 8 }, (_, i) =>
      c({ authorName: `P${i}`, authorEmail: `p${i}@example.test`, files: ['a.ts'] }),
    );
    expect(find(computeFileStats(commits, head, W), 'a.ts').authors).toHaveLength(5);
  });

  it('uses the most frequent display name for a key, scrubbed and truncated', () => {
    const commits = [
      c({ authorName: 'jane@example.com', authorEmail: 'j@example.test', files: ['a.ts'] }),
      c({ authorName: 'jane@example.com', authorEmail: 'j@example.test', files: ['a.ts'] }),
      c({ authorName: 'x'.repeat(300), authorEmail: 'j@example.test', files: ['a.ts'] }),
    ];
    const a = find(computeFileStats(commits, head, W), 'a.ts');
    expect(a.authors[0]?.name).toBe('jane');
    const long = find(
      computeFileStats([c({ authorName: 'y'.repeat(300), files: ['b.ts'] })], head, W),
      'b.ts',
    );
    expect(long.mainAuthor).toHaveLength(200);
  });

  it('handles one author, equal sizes and an empty history without throwing', () => {
    const same = [
      { path: 'p.ts', size: 5 },
      { path: 'q.ts', size: 5 },
    ];
    const stats = computeFileStats([c({ files: ['p.ts', 'q.ts'] })], same, W);
    expect(stats.every((s) => s.changes === 1 && s.mainAuthorShare === 1)).toBe(true);
    expect(computeFileStats([], same, W).every((s) => s.changes === 0)).toBe(true);
    expect(computeFileStats([], [], W)).toEqual([]);
  });

  it('is independent of head order and deduplicates head paths', () => {
    const a = computeFileStats([c({ files: ['a.ts'] })], [...head].reverse(), W);
    expect(a.map((s) => s.path)).toEqual(['a.ts', 'b.ts', 'cold.md']);
    expect(computeFileStats([], [head[0]!, head[0]!], W)).toHaveLength(1);
  });

  it('sets language from the path and keeps size', () => {
    const a = find(computeFileStats([], head, W), 'a.ts');
    expect(a).toMatchObject({ language: 'TypeScript', size: 100 });
  });

  it('output never contains an @ (emails or display names) and carries no subject', () => {
    const commits = [
      c({
        authorName: 'jane@example.com',
        authorEmail: 'Jane@Example.com',
        subject: 'Fix secret-subject',
        files: ['a.ts', 'b.ts'],
      }),
      c({ authorName: 'Bob', authorEmail: '12+bob@users.noreply.github.com', files: ['a.ts'] }),
    ];
    const json = JSON.stringify(computeFileStats(commits, head, W));
    expect(json).not.toContain('@');
    expect(json).not.toContain('secret-subject');
    expect(json.toLowerCase()).not.toContain('example.com');
  });

  it('produces FileStats the Analysis schema accepts', () => {
    const files = computeFileStats([c({ subject: 'Fix crash', files: ['a.ts'] })], head, W);
    const analysis = {
      schemaVersion: 1,
      repo: { owner: 'o', name: 'r', headSha: 'a'.repeat(40), defaultBranch: 'main' },
      window: { from: W, to: W + DAY, commits: 1 },
      stats: {
        bugFixCommitShare: 1,
        botCommitsExcluded: 0,
        commitsInWindow: 1,
        thinHistory: true,
        mailmapApplied: false,
        capsHit: [],
      },
      files,
      districts: [],
      report: { readFirst: [], riskiest: [], forgotten: [] },
    };
    expect(() => parseAnalysis(analysis)).not.toThrow();
  });
});
