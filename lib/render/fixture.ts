import type { FileStat } from '@/lib/analysis/types';

/** Small deterministic PRNG (mulberry32) so the fixture is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANGS: [string, string][] = [
  ['TypeScript', 'ts'],
  ['TypeScript', 'tsx'],
  ['Python', 'py'],
  ['Go', 'go'],
  ['Markdown', 'md'],
  ['CSS', 'css'],
  ['JSON', 'json'],
  ['Other', 'txt'],
];

/**
 * A synthetic repo of `count` files for the dev-only frame-time page: nested folders, skewed sizes
 * and change counts, some cold files and a dozen authors. Not real data.
 */
export function syntheticFiles(count = 5000, now = 1_800_000_000, seed = 42): FileStat[] {
  const rand = prng(seed);
  const authors = Array.from({ length: 12 }, (_, i) => ({
    key: i.toString(16).padStart(12, '0'),
    name: `Author ${i + 1}`,
  }));
  const files: FileStat[] = [];
  for (let i = 0; i < count; i++) {
    const top = `pkg${Math.floor(rand() * 20)}`;
    const mid = `mod${Math.floor(rand() * 12)}`;
    const deep = rand() < 0.3 ? `/sub${Math.floor(rand() * 4)}` : '';
    const [language, ext] = LANGS[Math.floor(rand() * LANGS.length)]!;
    const cold = rand() < 0.25;
    const changes = cold ? 0 : Math.max(1, Math.floor(Math.pow(rand(), 3) * 120));
    const author = authors[Math.floor(Math.pow(rand(), 2) * authors.length)]!;
    files.push({
      path: `${top}/${mid}${deep}/file${i}.${ext}`,
      size: Math.max(1, Math.floor(Math.pow(rand(), 4) * 60_000)),
      language,
      changes,
      lastChanged: cold ? null : now - Math.floor(rand() * 900 * 86_400),
      bugFixes: cold ? 0 : Math.floor(changes * rand() * 0.6),
      authors: cold ? [] : [{ key: author.key, name: author.name, share: 0.7 }],
      mainAuthor: cold ? null : author.name,
      mainAuthorShare: cold ? 0 : 0.7,
      coChange: [],
    });
  }
  return files;
}
