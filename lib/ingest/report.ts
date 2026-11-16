import type { Analysis, FileStat, Report } from '../analysis/types';

const LIST_SIZE = 10;
const MIN_CHANGES_FOR_RISK = 3;
const OWNER_SHARE_NUM = 4; // single-owner: at least 4/5 = 80% of file-touches
const OWNER_SHARE_DEN = 5;
const OWNER_MIN_CHANGES = 5;

/**
 * Lockfiles, minified and generated output, vendored code and images. They would
 * dominate hotspot ranking, so they are left out of the report card and out of the
 * hotspot ranking only; the files still appear in the city. Plan-level call, not in the spec.
 */
export const IGNORED_FOR_REPORT: RegExp[] = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/,
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /(^|\/)(dist|vendor|node_modules)\//,
  /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i,
];

function isIgnored(path: string): boolean {
  return IGNORED_FOR_REPORT.some((re) => re.test(path));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable report order: score descending, then size descending, then path ascending. */
function bySizeThenPath(a: FileStat, b: FileStat): number {
  return b.size - a.size || compare(a.path, b.path);
}

/**
 * Percentile rank in [0, 1] of each value among `values` (mid-rank for ties, so equal
 * values get equal ranks). With one value the rank is 0; when every value ties it is 0.5:
 * defined, never NaN.
 */
function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0);
  const sorted = [...values].sort((a, b) => a - b);
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  sorted.forEach((v, i) => {
    if (!first.has(v)) first.set(v, i);
    last.set(v, i);
  });
  return values.map((v) => ((first.get(v) ?? 0) + (last.get(v) ?? 0)) / 2 / (n - 1));
}

/**
 * Hotspot (spec section 8): percentile rank of `changes` times percentile rank of
 * `size`, 0 to 1, over the given files. A file with no change in the window scores 0.
 * Heuristic: a stand-in for "complicated and constantly edited".
 */
export function hotspotScore(files: FileStat[]): Map<string, number> {
  const changeRank = percentileRanks(files.map((f) => f.changes));
  const sizeRank = percentileRanks(files.map((f) => f.size));
  const out = new Map<string, number>();
  files.forEach((f, i) => {
    out.set(f.path, f.changes === 0 ? 0 : (changeRank[i] ?? 0) * (sizeRank[i] ?? 0));
  });
  return out;
}

function median(sortedAscending: number[]): number {
  const n = sortedAscending.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? (sortedAscending[mid] ?? 0)
    : ((sortedAscending[mid - 1] ?? 0) + (sortedAscending[mid] ?? 0)) / 2;
}

function top(files: FileStat[], score: (f: FileStat) => number): string[] {
  return files
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s || bySizeThenPath(a.f, b.f))
    .slice(0, LIST_SIZE)
    .map((x) => x.f.path);
}

/**
 * Report card (spec section 8), over files outside `IGNORED_FOR_REPORT`:
 * - readFirst: 0.5 rank(changes) + 0.3 rank(co-change degree) + 0.2 rank(distinct authors),
 *   files with no change in the window excluded;
 * - riskiest: hotspot times bug-fix density, files under 3 changes (and zero-risk files) excluded;
 * - forgotten: files above the median size with no change in the window, largest first, then
 *   in-window files above the median size by oldest last change.
 * Ties are broken by size descending, then path ascending. Lists hold at most 10 paths.
 * Distinct authors is capped at 5 per file by the schema.
 */
export function buildReport(files: FileStat[]): Report {
  const kept = files.filter((f) => !isIgnored(f.path));
  if (kept.length === 0) return { readFirst: [], riskiest: [], forgotten: [] };

  const changeRank = percentileRanks(kept.map((f) => f.changes));
  const degreeRank = percentileRanks(kept.map((f) => f.coChange.length));
  const authorRank = percentileRanks(kept.map((f) => f.authors.length));
  const read = new Map<string, number>();
  kept.forEach((f, i) => {
    read.set(
      f.path,
      0.5 * (changeRank[i] ?? 0) + 0.3 * (degreeRank[i] ?? 0) + 0.2 * (authorRank[i] ?? 0),
    );
  });
  const readFirst = top(
    kept.filter((f) => f.changes > 0),
    (f) => read.get(f.path) ?? 0,
  );

  const hot = hotspotScore(kept);
  const riskiest = top(
    kept.filter((f) => f.changes >= MIN_CHANGES_FOR_RISK && f.bugFixes > 0),
    (f) => (hot.get(f.path) ?? 0) * (f.bugFixes / f.changes),
  );

  const med = median(kept.map((f) => f.size).sort((a, b) => a - b));
  const large = kept.filter((f) => f.size > med);
  const cold = large.filter((f) => f.lastChanged === null).sort(bySizeThenPath);
  const stale = large
    .filter((f) => f.lastChanged !== null)
    .sort((a, b) => (a.lastChanged ?? 0) - (b.lastChanged ?? 0) || bySizeThenPath(a, b));
  const forgotten = [...cold, ...stale].slice(0, LIST_SIZE).map((f) => f.path);

  return { readFirst, riskiest, forgotten };
}

/**
 * Every folder at depth 1 or 2 from the repo root, sorted by path. `changes` sums the files
 * beneath it; the owner is the author with the most file-touches (share times changes,
 * rounded to whole touches), flagged `singleOwner` at 80% or more of the district's changes
 * and at least 5 changes. Because `authors` holds at most 5 per file this can under-flag,
 * never over-flag. Ignored files count here: the ignore list is for the report card only.
 */
export function singleOwnerDistricts(files: FileStat[]): Analysis['districts'] {
  type Acc = {
    changes: number;
    touches: Map<string, number>;
    names: Map<string, Map<string, number>>;
  };
  const acc = new Map<string, Acc>();

  for (const f of files) {
    const segments = f.path.split('/');
    const dirs: string[] = [];
    if (segments.length >= 2) dirs.push(segments[0] ?? '');
    if (segments.length >= 3) dirs.push(`${segments[0]}/${segments[1]}`);
    for (const dir of dirs) {
      const a = acc.get(dir) ?? { changes: 0, touches: new Map(), names: new Map() };
      a.changes += f.changes;
      for (const au of f.authors) {
        const n = Math.round(au.share * f.changes);
        a.touches.set(au.key, (a.touches.get(au.key) ?? 0) + n);
        const perName = a.names.get(au.key) ?? new Map<string, number>();
        perName.set(au.name, (perName.get(au.name) ?? 0) + n);
        a.names.set(au.key, perName);
      }
      acc.set(dir, a);
    }
  }

  return [...acc.keys()].sort(compare).map((path) => {
    const a = acc.get(path) as Acc;
    let ownerKey: string | null = null;
    let best = 0;
    for (const [key, n] of [...a.touches].sort((x, y) => compare(x[0], y[0]))) {
      if (n > best) {
        best = n;
        ownerKey = key;
      }
    }
    if (ownerKey === null || a.changes === 0) {
      return {
        path,
        singleOwner: false,
        ownerKey: null,
        ownerName: null,
        ownerShare: 0,
        changes: a.changes,
      };
    }
    let ownerName = 'unknown';
    let nameBest = -1;
    for (const [name, n] of [...(a.names.get(ownerKey) ?? [])].sort((x, y) =>
      compare(x[0], y[0]),
    )) {
      if (n > nameBest) {
        nameBest = n;
        ownerName = name;
      }
    }
    const share = Math.min(1, best / a.changes);
    const singleOwner =
      a.changes >= OWNER_MIN_CHANGES && best * OWNER_SHARE_DEN >= a.changes * OWNER_SHARE_NUM;
    return { path, singleOwner, ownerKey, ownerName, ownerShare: share, changes: a.changes };
  });
}
