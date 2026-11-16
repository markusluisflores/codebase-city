import { SCHEMA_VERSION } from '../analysis/schema';
import { CAPS } from '../caps';
import type { Analysis } from '../analysis/types';
import { computeCoChange } from './cochange';
import { computeFileStats, isBot, isBugFix } from './metrics';
import { parseLog } from './parseLog';
import { buildReport, singleOwnerDistricts } from './report';

export interface RepoMeta {
  owner: string;
  name: string;
  headSha: string;
  defaultBranch: string;
}

/** Limits that mirror the schema (`lib/analysis/schema.ts`); exceeding one is recorded in `stats.capsHit`, never thrown. */
const MAX_PATH = 1024;
const MAX_DISTRICTS = 2000;
const THIN_HISTORY_BELOW = 20;
const WINDOW_MONTHS = 24;

/** Unix seconds 24 months before `latestCommitUnix` (UTC); a 29 Feb start clamps to 28 Feb. */
export function windowStart(latestCommitUnix: number): number {
  const d = new Date(latestCommitUnix * 1000);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() - WINDOW_MONTHS;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  const out = new Date(d.getTime());
  out.setUTCFullYear(year, month, day);
  return Math.floor(out.getTime() / 1000);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Wires the ingestion pieces together: parse the history, compute per-file metrics and
 * co-change over the in-window human commits, then the report card and districts.
 * Pure: no I/O, no clock. Files whose path exceeds the schema's 1,024 characters are
 * skipped (`path_too_long`); districts beyond 2,000 are dropped, keeping those with the
 * most changes, ties by path ascending (`districts_truncated`). Author emails are used
 * only to derive hashed keys and never reach the output.
 */
export function analyze(input: {
  repo: RepoMeta;
  rawLog: string;
  head: { path: string; size: number }[];
  dropHashes?: Set<string>;
  windowFromUnix: number;
  mailmapApplied?: boolean;
}): Analysis {
  const capsHit = new Set<string>();

  const head = input.head.filter((f) => f.path.length > 0 && f.path.length <= MAX_PATH);
  if (head.length !== input.head.length) capsHit.add('path_too_long');

  const all = parseLog(input.rawLog, { dropHashes: input.dropHashes });
  const inWindow = all.filter((c) => c.time >= input.windowFromUnix);
  const human = inWindow.filter((c) => !isBot(c.authorName, c.authorEmail));
  const botCommitsExcluded = inWindow.length - human.length;
  const bugFixes = human.filter((c) => isBugFix(c.subject)).length;

  const files = computeFileStats(human, head, input.windowFromUnix);
  const coChange = computeCoChange(human, new Set(files.map((f) => f.path)));
  for (const f of files) f.coChange = coChange.get(f.path) ?? [];

  let districts = singleOwnerDistricts(files);
  if (districts.length > MAX_DISTRICTS) {
    capsHit.add('districts_truncated');
    districts = [...districts]
      .sort((a, b) => b.changes - a.changes || compare(a.path, b.path))
      .slice(0, MAX_DISTRICTS)
      .sort((a, b) => compare(a.path, b.path));
  }

  const latest = human.reduce((max, c) => Math.max(max, c.time), input.windowFromUnix);
  const report = buildReport(files);

  const result: Analysis = {
    schemaVersion: SCHEMA_VERSION,
    repo: { ...input.repo },
    window: { from: input.windowFromUnix, to: latest, commits: human.length },
    stats: {
      bugFixCommitShare: human.length === 0 ? 0 : bugFixes / human.length,
      botCommitsExcluded,
      commitsInWindow: human.length,
      thinHistory: human.length < THIN_HISTORY_BELOW,
      mailmapApplied: input.mailmapApplied ?? false,
      capsHit: [...capsHit].sort(compare),
    },
    files,
    districts,
    report,
  };
  return fitToSizeBound(result);
}

const SIZE_STEPS: { coChange: number; authors: number }[] = [
  { coChange: 3, authors: 5 },
  { coChange: 1, authors: 3 },
  { coChange: 0, authors: 1 },
];

function serialisedBytes(a: Analysis): number {
  return Buffer.byteLength(JSON.stringify(a), 'utf8');
}

/**
 * A 10,000-file repo whose files all carry 5 authors and 5 co-change partners serialises
 * past the 8 MB bound (measured about 11 MB with 80-character paths). Rather than let the
 * schema reject the result, shed the least valuable detail in fixed steps (co-change
 * partners first, then authors beyond the main one) and record `size_trimmed`. The report
 * card and districts were already computed from the full data; the trim is deterministic.
 */
function fitToSizeBound(analysis: Analysis): Analysis {
  if (serialisedBytes(analysis) <= CAPS.maxStdoutBytes) return analysis;
  const capsHit = [...analysis.stats.capsHit, 'size_trimmed'].sort(compare);
  let current = analysis;
  for (const step of SIZE_STEPS) {
    current = {
      ...analysis,
      stats: { ...analysis.stats, capsHit },
      files: analysis.files.map((f) => ({
        ...f,
        coChange: f.coChange.slice(0, step.coChange),
        authors: f.authors.slice(0, step.authors),
      })),
    };
    if (serialisedBytes(current) <= CAPS.maxStdoutBytes) break;
  }
  return current;
}
