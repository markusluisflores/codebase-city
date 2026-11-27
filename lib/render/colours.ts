import type { FileStat } from '@/lib/analysis/types';
import { hotspotScore, isIgnored } from '@/lib/ingest/report';

export type ColourMode = 'hotspot' | 'churn' | 'age' | 'bugfix' | 'language' | 'ownership';

export const COLOUR_MODES: readonly ColourMode[] = [
  'hotspot',
  'churn',
  'age',
  'bugfix',
  'language',
  'ownership',
];

/** Dark-theme semantic tokens ("Night Ember"). Mirrored as CSS custom properties in app/globals.css. */
export const TOKENS = {
  bg: '#0b1020',
  surface: '#131a2e',
  text: '#e6eaf5',
  muted: '#94a3b8',
  border: '#2a3350',
  accent: '#fb923c',
  cold: '#6b7280',
} as const;

/** Neutral grey: no activity in the window (or too little data for the mode). */
export const COLD = TOKENS.cold;

/**
 * Sequential ramp, cold to hot (7 stops, inferno-like). Used by hotspot, churn, age and bug-fix.
 * The cold end is lifted (decided 2026-11-26): the first stop is 2.1:1 and the second 3.1:1 against the
 * floor plate, so low-activity buildings stay visible; adjacent luminance gaps are 0.059 to 0.24.
 */
export const SEQUENTIAL: readonly string[] = [
  '#8c2367',
  '#b83854',
  '#dc5537',
  '#f57c16',
  '#f9ad22',
  '#fbd956',
  '#fcffa3',
];

/**
 * Categorical palette: Okabe-Ito's 7 colours plus a near-white as the 8th, since Okabe-Ito's black
 * is invisible on the dark background. Language uses the first 7; ownership uses all 8.
 */
export const AUTHOR_COLOURS: readonly string[] = [
  '#E69F00',
  '#56B4E9',
  '#009E73',
  '#F0E442',
  '#0072B2',
  '#D55E00',
  '#CC79A7',
  '#F5F5F5',
];

/**
 * Light grey for "others" (languages beyond 7, authors beyond 8). Differs from `COLD`. Lighter than
 * Okabe-Ito's #999999 (decided 2026-11-26), which was nearly the same as the pink for deuteranopia.
 */
export const OTHERS = '#bdbdbd';

export const MAX_LANGUAGES = 7;
export const MAX_OWNERS = 8;

/** Upper bounds in days of the first five age buckets; anything older is the sixth ("older than window"). */
export const AGE_BUCKET_DAYS: readonly number[] = [30, 90, 180, 365, 730];

/** Age buckets, freshest first, hot to cold. The stalest uses the second-coldest stop so it stays visible on the dark ground. */
export const AGE_COLOURS: readonly string[] = [6, 5, 4, 3, 2, 1].map((i) => SEQUENTIAL[i]!);

/** Churn buckets on a log2 scale: 1, 2-3, 4-7, 8-15, 16-31, 32-63, 64+ changes. */
export const CHURN_BUCKETS = 7;

/** Bug-fix buckets by share of changes that were bug fixes; upper bounds of the first six. */
export const BUGFIX_SHARE_BOUNDS: readonly number[] = [0, 0.1, 0.2, 0.35, 0.5, 0.7];

/** Files with fewer changes than this get no bug-fix density (too few to be meaningful). */
export const BUGFIX_MIN_CHANGES = 3;

export interface ColourContext {
  /** Hotspot score per path, 0 to 1. */
  hotspot: Map<string, number>;
  /** Unix seconds; the viewer passes `window.to`. */
  now: number;
  /** Main author key per path. */
  owners: Map<string, string>;
  /** Author keys by files owned, most first; the first 8 get their own colour. */
  topOwners: string[];
  /** Languages by file count, most first (without "Other"); the first 7 get their own colour. */
  topLanguages?: string[];
  /** Display names by author key, for legends and tooltips. */
  ownerNames?: Map<string, string>;
}

const DAY = 86_400;

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Continuous position on the ramp, `t` in 0 to 1. The 7 stops are already spaced to be
 * perceptually even, so linear interpolation in sRGB between neighbours is faithful and cheap.
 */
export function rampAt(t: number): string {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const pos = x * (SEQUENTIAL.length - 1);
  const i = Math.min(SEQUENTIAL.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = parseHex(SEQUENTIAL[i]!);
  const b = parseHex(SEQUENTIAL[i + 1]!);
  return toHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

export function churnBucket(changes: number): number {
  if (!(changes >= 1)) return -1;
  return Math.min(CHURN_BUCKETS - 1, Math.floor(Math.log2(changes)));
}

export function bugfixBucket(file: Pick<FileStat, 'changes' | 'bugFixes'>): number {
  if (!(file.changes >= BUGFIX_MIN_CHANGES)) return -1;
  const share = Math.min(1, Math.max(0, file.bugFixes / file.changes));
  const i = BUGFIX_SHARE_BOUNDS.findIndex((bound) => share <= bound);
  return i < 0 ? BUGFIX_SHARE_BOUNDS.length : i;
}

/** Index 0 (freshest) to 5 (older than window). A file with no change in the window is the stalest. */
export function ageBucket(lastChanged: number | null, now: number): number {
  if (lastChanged === null) return AGE_BUCKET_DAYS.length;
  const days = (now - lastChanged) / DAY;
  const i = AGE_BUCKET_DAYS.findIndex((bound) => days <= bound);
  return i < 0 ? AGE_BUCKET_DAYS.length : i;
}

/** Hex colour (`#rrggbb`) of a file in the given mode. Never throws and never returns undefined. */
export function colourFor(mode: ColourMode, file: FileStat, ctx: ColourContext): string {
  if (mode === 'age') return AGE_COLOURS[ageBucket(file.lastChanged, ctx.now)]!;
  if (mode === 'language') {
    const i = (ctx.topLanguages ?? []).indexOf(file.language);
    return i >= 0 && i < MAX_LANGUAGES ? AUTHOR_COLOURS[i]! : OTHERS;
  }
  if (file.lastChanged === null) return COLD;
  switch (mode) {
    case 'hotspot': {
      const v = ctx.hotspot.get(file.path);
      return v === undefined ? COLD : rampAt(v);
    }
    case 'churn': {
      const b = churnBucket(file.changes);
      return b < 0 ? COLD : SEQUENTIAL[b]!;
    }
    case 'bugfix': {
      const b = bugfixBucket(file);
      return b < 0 ? COLD : SEQUENTIAL[b]!;
    }
    case 'ownership': {
      const key = ctx.owners.get(file.path);
      if (key === undefined) return COLD;
      const i = ctx.topOwners.indexOf(key);
      return i >= 0 && i < MAX_OWNERS ? AUTHOR_COLOURS[i]! : OTHERS;
    }
  }
}

function rankDesc(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k]) => k);
}

/**
 * Derives everything the colour modes need from the file list: the hotspot score (the report card's `hotspotScore`), each file's main author, the top authors and
 * the top languages. `now` is the window end in unix seconds.
 */
export function buildColourContext(files: readonly FileStat[], now: number): ColourContext {
  // Same score as the report card (lockfiles, minified and vendored files are left out of the ranking,
  // so they show grey in hotspot mode), so the city and the "riskiest" list agree.
  const hotspot = hotspotScore(files.filter((f) => !isIgnored(f.path)));
  const owners = new Map<string, string>();
  const ownerNames = new Map<string, string>();
  const ownerCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  for (const f of files) {
    const main = f.mainAuthor === null ? undefined : f.authors[0];
    if (main) {
      owners.set(f.path, main.key);
      ownerNames.set(main.key, main.name);
      ownerCounts.set(main.key, (ownerCounts.get(main.key) ?? 0) + 1);
    }
    if (f.language !== 'Other')
      languageCounts.set(f.language, (languageCounts.get(f.language) ?? 0) + 1);
  }
  return {
    hotspot,
    now,
    owners,
    topOwners: rankDesc(ownerCounts),
    topLanguages: rankDesc(languageCounts),
    ownerNames,
  };
}
