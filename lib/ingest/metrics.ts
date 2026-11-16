import { createHash } from 'node:crypto';
import type { AuthorShare, FileStat } from '../analysis/types';
import type { Commit } from './parseLog';

const MAX_AUTHORS = 5;
const MAX_NAME = 200;

/** Spec section 8: bug-fix subjects, minus noise such as typo, lint and docs fixes. Heuristic. */
const BUG_FIX = /\b(fix(es|ed)?|bug|hotfix|regression|crash|defect)\b/i;
const NOT_BUG_FIX = /typo|lint|format|whitespace|docs?:/i;

export function isBugFix(subject: string): boolean {
  return BUG_FIX.test(subject) && !NOT_BUG_FIX.test(subject);
}

const BOT = /\[bot\]|dependabot|renovate|github-actions/i;

/** Names or emails matching `[bot]`, dependabot, renovate or github-actions. */
export function isBot(name: string, email: string): boolean {
  return BOT.test(name) || BOT.test(email);
}

/** Lower-cased, trimmed; GitHub's `<id>+<name>@users.noreply.github.com` becomes `<name>@users.noreply.github.com`. */
export function normaliseEmail(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/^\d+\+(.+@users\.noreply\.github\.com)$/, '$1');
}

/** First 12 hex characters of the SHA-256 of the normalised email: a pseudonymised, unsalted key (matchable against a known address). */
export function authorKey(email: string): string {
  return createHash('sha256').update(normaliseEmail(email)).digest('hex').slice(0, 12);
}

/** Cuts a display name at any `@`, trims it and bounds it to 200 characters; an empty result becomes `unknown`. */
export function scrubName(name: string): string {
  const cut = name.split('@')[0] ?? '';
  const trimmed = Array.from(cut.trim()).slice(0, MAX_NAME).join('').trim(); // by code point: never splits a surrogate pair
  return trimmed === '' ? 'unknown' : trimmed;
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  hh: 'C++',
  cs: 'C#',
  php: 'PHP',
  scala: 'Scala',
  dart: 'Dart',
  lua: 'Lua',
  r: 'R',
  ex: 'Elixir',
  exs: 'Elixir',
  hs: 'Haskell',
  clj: 'Clojure',
  m: 'Objective-C',
  mm: 'Objective-C',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  bat: 'Batch',
  cmd: 'Batch',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'CSS',
  sass: 'CSS',
  less: 'CSS',
  vue: 'Vue',
  svelte: 'Svelte',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  sql: 'SQL',
  graphql: 'GraphQL',
  md: 'Markdown',
  mdx: 'Markdown',
  rst: 'reStructuredText',
  txt: 'Text',
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  gif: 'Image',
  svg: 'Image',
  webp: 'Image',
  ico: 'Image',
};

const BY_FILENAME: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
};

/** Language from the file extension (or well-known file name); `Other` when unknown. */
export function languageOf(path: string): string {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  const byName = BY_FILENAME[base];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'Other'; // no extension, or a dotfile such as `.gitignore`
  const lang = BY_EXTENSION[base.slice(dot + 1)];
  return lang ?? 'Other';
}

/** Author identity: the email key, or, when the email is empty (git allows it), a key from the scrubbed name so unrelated empty-email authors are not merged. */
function identityKey(name: string, email: string): string {
  return normaliseEmail(email) === '' ? authorKey(`name:${scrubName(name)}`) : authorKey(email);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Per-file churn, bug-fix, recency and ownership for every file at HEAD (without
 * `coChange`, which Task 6 fills). Only commits at or after `windowFromUnix` count;
 * bot commits are excluded entirely (not churn, not authors). Files with no
 * in-window human commit are still listed, cold. Output is sorted by path, so it
 * does not depend on the order of `head` or `commits`. Commit subjects are used
 * only to count bug fixes and are never stored.
 */
export function computeFileStats(
  commits: Commit[],
  head: { path: string; size: number }[],
  windowFromUnix: number,
): FileStat[] {
  const sizes = new Map<string, number>();
  for (const f of head) if (!sizes.has(f.path)) sizes.set(f.path, f.size);

  type Acc = {
    changes: number;
    bugFixes: number;
    last: number | null;
    byAuthor: Map<string, number>;
  };
  const acc = new Map<string, Acc>();
  // key -> display name -> count, to pick each author's most frequent name.
  const names = new Map<string, Map<string, number>>();

  for (const commit of commits) {
    if (commit.time < windowFromUnix) continue;
    if (isBot(commit.authorName, commit.authorEmail)) continue;
    const key = identityKey(commit.authorName, commit.authorEmail);
    const name = scrubName(commit.authorName);
    const perKey = names.get(key) ?? new Map<string, number>();
    perKey.set(name, (perKey.get(name) ?? 0) + 1);
    names.set(key, perKey);
    const bug = isBugFix(commit.subject);

    for (const path of new Set(commit.files)) {
      if (!sizes.has(path)) continue;
      const a = acc.get(path) ?? { changes: 0, bugFixes: 0, last: null, byAuthor: new Map() };
      a.changes += 1;
      if (bug) a.bugFixes += 1;
      a.last = a.last === null ? commit.time : Math.max(a.last, commit.time);
      a.byAuthor.set(key, (a.byAuthor.get(key) ?? 0) + 1);
      acc.set(path, a);
    }
  }

  const displayName = (key: string): string => {
    const counts = names.get(key);
    let best = 'unknown';
    let bestCount = -1;
    for (const [n, count] of counts ?? []) {
      if (count > bestCount || (count === bestCount && n < best)) {
        best = n;
        bestCount = count;
      }
    }
    return best;
  };

  return [...sizes.keys()].sort(compare).map((path): FileStat => {
    const a = acc.get(path);
    const size = sizes.get(path) ?? 0;
    const base = { path, size, language: languageOf(path), coChange: [] };
    if (!a) {
      return {
        ...base,
        changes: 0,
        lastChanged: null,
        bugFixes: 0,
        authors: [],
        mainAuthor: null,
        mainAuthorShare: 0,
      };
    }
    const authors: AuthorShare[] = [...a.byAuthor.entries()]
      .sort((x, y) => y[1] - x[1] || compare(x[0], y[0]))
      .slice(0, MAX_AUTHORS)
      .map(([key, n]) => ({ key, name: displayName(key), share: n / a.changes }));
    return {
      ...base,
      changes: a.changes,
      lastChanged: a.last,
      bugFixes: a.bugFixes,
      authors,
      mainAuthor: authors[0]?.name ?? null,
      mainAuthorShare: authors[0]?.share ?? 0,
    };
  });
}
