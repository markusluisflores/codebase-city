import { parseAnalysis } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';
import { galleryCard, type GalleryCard } from '@/lib/gallery-cards';
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
  // The home-page card is best effort: it must never fail or undo an analysis (the column may not be
  // migrated yet, or the card may not build). A missing card is filled in later by the home page.
  try {
    await putCard(valid.repo.owner, valid.repo.name, valid.schemaVersion, galleryCard(valid, now));
  } catch {
    // On a re-analysis the row still holds the previous analysis's card. Clear it (best effort) so
    // the home page backfills a fresh one instead of showing a stale card; see lib/db/cards.ts.
    try {
      await getDb().query(
        `UPDATE analyses SET card = NULL WHERE owner = $1 AND name = $2 AND schema_version = $3`,
        [keyPart(valid.repo.owner), keyPart(valid.repo.name), valid.schemaVersion],
      );
    } catch {
      // The column may not exist at all; nothing more to do.
    }
  }
}

/** Stores the home-page card for a row; `onlyIfNull` keeps a card a concurrent re-analysis already wrote (throws on a database error, for example an unmigrated table). */
export async function putCard(
  owner: string,
  name: string,
  schemaVersion: number,
  card: GalleryCard,
  opts: { onlyIfNull?: boolean } = {},
): Promise<void> {
  await getDb().query(
    `UPDATE analyses SET card = $4::jsonb WHERE owner = $1 AND name = $2 AND schema_version = $3${
      opts.onlyIfNull ? ' AND card IS NULL' : ''
    }`,
    [keyPart(owner), keyPart(name), schemaVersion, JSON.stringify(card)],
  );
}
