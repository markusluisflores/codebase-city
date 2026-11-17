import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';

/** A small valid Analysis for database tests. */
export function sampleAnalysis(
  owner = 'Octo',
  name = 'Repo',
  headSha = 'a'.repeat(40),
  schemaVersion: number = SCHEMA_VERSION,
): Analysis {
  return {
    schemaVersion,
    repo: { owner, name, headSha, defaultBranch: 'main' },
    window: { from: 1_650_000_000, to: 1_710_000_000, commits: 10 },
    stats: {
      bugFixCommitShare: 0.1,
      botCommitsExcluded: 0,
      commitsInWindow: 10,
      thinHistory: true,
      mailmapApplied: false,
      capsHit: [],
    },
    files: [
      {
        path: 'src/index.ts',
        size: 120,
        language: 'TypeScript',
        changes: 4,
        lastChanged: 1_700_000_000,
        bugFixes: 1,
        authors: [{ key: '000000000001', name: 'Ada Lovelace', share: 1 }],
        mainAuthor: 'Ada Lovelace',
        mainAuthorShare: 1,
        coChange: [],
      },
    ],
    districts: [],
    report: { readFirst: ['src/index.ts'], riskiest: [], forgotten: [] },
  };
}
