import type { Analysis, FileStat } from '@/lib/analysis/types';
import { sampleAnalysis } from './sampleAnalysis';

export const NOW = 1_710_000_000;

export function fileStat(over: Partial<FileStat> = {}): FileStat {
  return {
    path: 'src/a.ts',
    size: 1200,
    language: 'TypeScript',
    changes: 12,
    lastChanged: NOW - 86_400 * 3,
    bugFixes: 4,
    authors: [{ key: '000000000001', name: 'Ada Lovelace', share: 0.75 }],
    mainAuthor: 'Ada Lovelace',
    mainAuthorShare: 0.75,
    coChange: [{ path: 'src/b.ts', shared: 5, score: 0.5 }],
    ...over,
  };
}

/** Four files in two folders, one cold; the `src` district is single-owner (86%). */
export function viewerAnalysis(over: Partial<Analysis['stats']> = {}): Analysis {
  const base = sampleAnalysis('octo', 'repo', 'b'.repeat(40));
  return {
    ...base,
    window: { from: NOW - 86_400 * 365, to: NOW, commits: 100 },
    stats: {
      ...base.stats,
      bugFixCommitShare: 0.2,
      thinHistory: false,
      mailmapApplied: true,
      ...over,
    },
    files: [
      fileStat({ path: 'src/a.ts', size: 3000, changes: 30, bugFixes: 9 }),
      fileStat({ path: 'src/b.ts', size: 1500, changes: 8, bugFixes: 0 }),
      fileStat({ path: 'docs/readme.md', size: 800, language: 'Markdown', changes: 2 }),
      fileStat({
        path: 'docs/old file #1.md',
        size: 400,
        language: 'Markdown',
        changes: 0,
        lastChanged: null,
        authors: [],
        mainAuthor: null,
        mainAuthorShare: 0,
        coChange: [],
      }),
    ],
    districts: [
      {
        path: 'src',
        singleOwner: true,
        ownerKey: '000000000001',
        ownerName: 'Ada Lovelace',
        ownerShare: 0.86,
        changes: 38,
      },
      {
        path: 'docs',
        singleOwner: false,
        ownerKey: null,
        ownerName: null,
        ownerShare: 0.4,
        changes: 2,
      },
    ],
    report: {
      readFirst: ['src/a.ts', 'src/b.ts'],
      riskiest: ['src/a.ts'],
      forgotten: ['docs/old file #1.md'],
    },
  };
}
