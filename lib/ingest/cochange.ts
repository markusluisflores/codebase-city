import type { CoChange } from '../analysis/types';
import type { Commit } from './parseLog';

/** Spec section 8 thresholds. Heuristic. */
const MAX_FILES_PER_COMMIT = 30;
const MIN_CHANGES = 3;
const MIN_SHARED = 3;
const MIN_SCORE_NUM = 3; // Jaccard >= 3/10, compared in integers to avoid float edge cases
const MIN_SCORE_DEN = 10;
const MAX_PARTNERS = 5;

/**
 * Co-change coupling between files at HEAD (spec section 8). The caller passes
 * the commits it wants counted (in the window, bots already removed).
 *
 * - Only commits touching 30 files or fewer contribute shared counts.
 * - A file's change total counts every commit that touches it, including
 *   over-cap ones, so the Jaccard denominator (commits touching either file)
 *   matches `FileStat.changes` and big sweeping commits cannot inflate scores.
 * - Only files at HEAD with at least 3 changes take part; pairs need at least
 *   3 shared commits and a score of at least 0.3; top 5 per file, by score
 *   descending then path ascending.
 *
 * Cost: the cap is checked before any pair is generated and only eligible
 * files are paired, so a commit costs at most 30*29/2 = 435 increments; a
 * 20,000-commit window is at most about 8.7 million integer-keyed map updates.
 * The output does not depend on the order of commits, paths or `headPaths`.
 */
export function computeCoChange(
  commits: Commit[],
  headPaths: Set<string>,
): Map<string, CoChange[]> {
  const result = new Map<string, CoChange[]>();
  if (headPaths.size === 0) return result;

  // Pass 1: change totals per HEAD file.
  const changes = new Map<string, number>();
  for (const commit of commits) {
    for (const path of new Set(commit.files)) {
      if (headPaths.has(path)) changes.set(path, (changes.get(path) ?? 0) + 1);
    }
  }

  // Index the eligible files (sorted, so indexes and tie-breaks are deterministic).
  const eligible = [...changes]
    .filter(([, c]) => c >= MIN_CHANGES)
    .map(([p]) => p)
    .sort();
  if (eligible.length < 2) return result;
  const index = new Map(eligible.map((p, i) => [p, i]));
  const total = eligible.length;
  const changeOf = eligible.map((p) => changes.get(p) as number);

  // Pass 2: shared counts, keyed by lo * total + hi.
  const shared = new Map<number, number>();
  for (const commit of commits) {
    const unique = new Set(commit.files);
    if (unique.size > MAX_FILES_PER_COMMIT) continue;
    const ids: number[] = [];
    for (const path of unique) {
      const id = index.get(path);
      if (id !== undefined) ids.push(id);
    }
    ids.sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++) {
      const base = (ids[i] as number) * total;
      for (let j = i + 1; j < ids.length; j++) {
        const key = base + (ids[j] as number);
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }

  const partners = new Map<number, CoChange[]>();
  const push = (from: number, to: number, count: number, score: number): void => {
    const list = partners.get(from) ?? [];
    list.push({ path: eligible[to] as string, shared: count, score });
    partners.set(from, list);
  };
  for (const [key, count] of shared) {
    if (count < MIN_SHARED) continue;
    const lo = Math.floor(key / total);
    const hi = key % total;
    const union = (changeOf[lo] as number) + (changeOf[hi] as number) - count;
    if (count * MIN_SCORE_DEN < union * MIN_SCORE_NUM) continue;
    const score = count / union;
    push(lo, hi, count, score);
    push(hi, lo, count, score);
  }

  for (const [id, list] of partners) {
    list.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    result.set(eligible[id] as string, list.slice(0, MAX_PARTNERS));
  }
  return result;
}
