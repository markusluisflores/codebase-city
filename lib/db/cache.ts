import { parseAnalysis } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';
import { getDb } from './client';

// GitHub owner and repo names are case-insensitive, so the key is stored lower-case.
function keyPart(s: string): string {
  return s.toLowerCase();
}

/**
 * The stored analysis for `(owner, name, schemaVersion)`, or null on a miss. A row that no longer
 * parses (corrupted, or written under an older schema) is a miss, never a crash. The stored `headSha`
 * is `analysis.repo.headSha`.
 */
export async function getCached(
  owner: string,
  name: string,
  schemaVersion: number,
): Promise<{ analysis: Analysis; analysedAt: Date } | null> {
  const rows = await getDb().query<{ analysis: unknown; analysed_at: Date | string }>(
    `SELECT analysis, analysed_at FROM analyses
      WHERE owner = $1 AND name = $2 AND schema_version = $3`,
    [keyPart(owner), keyPart(name), schemaVersion],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    const analysis = parseAnalysis(row.analysis);
    if (analysis.schemaVersion !== schemaVersion) return null;
    return { analysis, analysedAt: new Date(row.analysed_at) };
  } catch {
    return null;
  }
}

/**
 * Validates `analysis` (throws on an invalid one, so a bad value never reaches the cache) and
 * replaces the row for its `(owner, name, schemaVersion)`.
 */
export async function putCached(analysis: Analysis, now: Date): Promise<void> {
  const valid = parseAnalysis(analysis);
  await getDb().query(
    `INSERT INTO analyses (owner, name, schema_version, head_sha, analysed_at, analysis)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (owner, name, schema_version) DO UPDATE
       SET head_sha = EXCLUDED.head_sha,
           analysed_at = EXCLUDED.analysed_at,
           analysis = EXCLUDED.analysis`,
    [
      keyPart(valid.repo.owner),
      keyPart(valid.repo.name),
      valid.schemaVersion,
      valid.repo.headSha,
      now.toISOString(),
      JSON.stringify(valid),
    ],
  );
}
