import { describe, expect, it } from 'vitest';
import { computeCoChange } from '../../lib/ingest/cochange';
import type { Commit } from '../../lib/ingest/parseLog';

let n = 0;
function commit(files: string[]): Commit {
  n += 1;
  return {
    hash: n.toString(16).padStart(40, '0'),
    authorName: 'Ada',
    authorEmail: 'ada@example.test',
    time: 1_700_000_000 + n,
    subject: 'change',
    files,
  };
}
const many = (count: number, prefix = 'm') =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}.ts`);

describe('computeCoChange', () => {
  it('scores two files changed together in 4 of 5 commits as 0.8 with shared 4', () => {
    const commits = [
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts']),
    ];
    const result = computeCoChange(commits, new Set(['a.ts', 'b.ts']));
    expect(result.get('a.ts')).toEqual([{ path: 'b.ts', shared: 4, score: 0.8 }]);
    expect(result.get('b.ts')).toEqual([{ path: 'a.ts', shared: 4, score: 0.8 }]);
  });

  it('ignores commits that touch more than 30 files and keeps those with exactly 30', () => {
    const big = (extra: string[]) => [...extra, ...many(28)];
    const over = [1, 2, 3].map(() => commit(['a.ts', 'b.ts', ...many(29)]));
    expect(computeCoChange(over, new Set(['a.ts', 'b.ts', ...many(29)])).size).toBe(0);
    const exact = [1, 2, 3].map(() => commit(big(['a.ts', 'b.ts'])));
    const result = computeCoChange(exact, new Set(['a.ts', 'b.ts']));
    expect(result.get('a.ts')?.[0]).toMatchObject({ path: 'b.ts', shared: 3 });
  });

  it('counts an over-cap commit in a file’s change total so the score is not inflated', () => {
    const commits = [
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', ...many(30)]),
      commit(['b.ts', ...many(30)]),
    ];
    const result = computeCoChange(commits, new Set(['a.ts', 'b.ts']));
    expect(result.get('a.ts')).toEqual([{ path: 'b.ts', shared: 3, score: 0.6 }]);
  });

  it('drops pairs with fewer than 3 shared commits', () => {
    const commits = [
      commit(['a.ts', 'b.ts']),
      commit(['a.ts', 'b.ts']),
      commit(['a.ts']),
      commit(['b.ts']),
    ];
    expect(computeCoChange(commits, new Set(['a.ts', 'b.ts'])).size).toBe(0);
  });

  it('drops pairs with a Jaccard score under 0.3', () => {
    // shared 3; a has 3 + 7 solo = 10, b has 3: union 10, score 0.3 (kept); one more solo makes 3/11
    const together = [1, 2, 3].map(() => commit(['a.ts', 'b.ts']));
    const solo = (k: number) => Array.from({ length: k }, () => commit(['a.ts']));
    expect(
      computeCoChange([...together, ...solo(7)], new Set(['a.ts', 'b.ts'])).get('b.ts'),
    ).toEqual([{ path: 'a.ts', shared: 3, score: 0.3 }]);
    expect(
      computeCoChange([...together, ...solo(8)], new Set(['a.ts', 'b.ts'])).get('b.ts'),
    ).toBeUndefined();
  });

  it('keeps at most 5 partners per file, ordered by score then path', () => {
    const partners = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((p) => `${p}.ts`);
    const commits: Commit[] = [];
    for (let i = 0; i < 3; i++) commits.push(commit(['hub.ts', ...partners]));
    // p1 also changes alone once, so it scores lower than the tied rest despite sorting first by path.
    commits.push(commit(['p1.ts']));
    const result = computeCoChange(commits, new Set(['hub.ts', ...partners]));
    const hub = result.get('hub.ts') ?? [];
    expect(hub).toHaveLength(5);
    expect(hub.map((c) => c.path)).toEqual(['p2.ts', 'p3.ts', 'p4.ts', 'p5.ts', 'p6.ts']);
    expect(hub.every((c, i) => i === 0 || hub[i - 1]!.score >= c.score)).toBe(true);
  });

  it('never reports files that are not at HEAD', () => {
    const commits = [1, 2, 3].map(() => commit(['a.ts', 'gone.ts']));
    expect(computeCoChange(commits, new Set(['a.ts'])).size).toBe(0);
  });

  it('gives nothing to a file with fewer than 3 changes', () => {
    const commits = [commit(['a.ts', 'b.ts']), commit(['a.ts', 'b.ts'])];
    expect(computeCoChange(commits, new Set(['a.ts', 'b.ts'])).size).toBe(0);
  });

  it('handles empty history and an empty HEAD set', () => {
    expect(computeCoChange([], new Set(['a.ts'])).size).toBe(0);
    expect(computeCoChange([commit(['a.ts', 'b.ts'])], new Set()).size).toBe(0);
  });

  it('counts a path repeated within one commit once', () => {
    const commits = [1, 2, 3].map(() => commit(['a.ts', 'a.ts', 'b.ts']));
    expect(computeCoChange(commits, new Set(['a.ts', 'b.ts'])).get('a.ts')).toEqual([
      { path: 'b.ts', shared: 3, score: 1 },
    ]);
  });

  it('is deterministic for any commit or file order', () => {
    const commits = [1, 2, 3].flatMap(() => [
      commit(['a.ts', 'b.ts', 'c.ts']),
      commit(['c.ts', 'd.ts']),
    ]);
    const head = new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const one = computeCoChange(commits, head);
    const two = computeCoChange(
      [...commits].reverse().map((c) => ({ ...c, files: [...c.files].reverse() })),
      new Set([...head].reverse()),
    );
    expect(JSON.stringify([...one].sort())).toBe(JSON.stringify([...two].sort()));
    expect(one.get('c.ts')?.map((c) => c.path)).toEqual(['a.ts', 'b.ts', 'd.ts']);
  });

  it('stays fast on 20,000 commits of 30 files', () => {
    const head = new Set(many(200, 'f'));
    const commits = Array.from({ length: 20_000 }, (_, i) =>
      commit(Array.from({ length: 30 }, (_, k) => `f${(i * 7 + k * 3) % 200}.ts`)),
    );
    const start = Date.now();
    computeCoChange(commits, head);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
