import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import { galleryCard, parseCard, type GalleryCard } from '@/lib/gallery-cards';
import { getCached, putCard } from './cache';
import { getDb } from './client';

/**
 * The newest live analyses as cards, at most `limit`. Reads the small `card` column only, never the
 * analysis. A row with no card or a malformed one is skipped. Throws on a database error: the caller
 * decides how to degrade.
 */
export async function listLiveCards(limit: number): Promise<GalleryCard[]> {
  const rows = await getDb().query<{ card: unknown }>(
    `SELECT card FROM analyses
      WHERE schema_version = $1 AND card IS NOT NULL
      ORDER BY analysed_at DESC
      LIMIT $2`,
    [SCHEMA_VERSION, limit],
  );
  const cards: GalleryCard[] = [];
  for (const row of rows) {
    const card = parseCard(row.card);
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * Builds the card for up to `limit` of the newest rows that have none (rows analysed before the column
 * existed, or whose card write failed). Each one reads a full analysis, so the count is small and the
 * home page's revalidation interval spreads the rest over later renders. Returns how many it filled.
 *
 * One row never aborts the loop. A row that cannot produce a card (it no longer parses, or the card
 * fails to build or store) gets the sentinel card `{}` so it is no longer `card IS NULL` and is not
 * re-read on every render; `listLiveCards` skips it because `parseCard` rejects `{}`. The sentinel
 * write is best effort and its own failure is swallowed. A later successful re-analysis overwrites
 * the sentinel through `putCached`'s card write. Only rows that really got a card are counted.
 */
export async function backfillCards(limit: number): Promise<number> {
  const rows = await getDb().query<{ owner: string; name: string }>(
    `SELECT owner, name FROM analyses
      WHERE schema_version = $1 AND card IS NULL
      ORDER BY analysed_at DESC
      LIMIT $2`,
    [SCHEMA_VERSION, limit],
  );
  let filled = 0;
  for (const { owner, name } of rows) {
    try {
      const hit = await getCached(owner, name, SCHEMA_VERSION);
      if (!hit) throw new Error('analysis row does not parse');
      await putCard(owner, name, SCHEMA_VERSION, galleryCard(hit.analysis, hit.analysedAt));
      filled++;
    } catch {
      try {
        await getDb().query(
          `UPDATE analyses SET card = '{}'::jsonb WHERE owner = $1 AND name = $2 AND schema_version = $3`,
          [owner, name, SCHEMA_VERSION],
        );
      } catch {
        // Best effort: the row stays card-less and is retried on a later render.
      }
    }
  }
  return filled;
}
