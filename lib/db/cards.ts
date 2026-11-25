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
 * One row never aborts the loop. A row that definitely cannot produce a card (its analysis no longer
 * parses, or `galleryCard` throws on it) gets the sentinel card `{}` so it is no longer `card IS NULL`
 * and is not re-read on every render; `listLiveCards` skips it because `parseCard` rejects `{}`. A
 * database error (reading the analysis or storing the card) may be transient, so it writes no sentinel:
 * the card stays NULL and a later render retries. The sentinel write is best effort and its own
 * failure is swallowed. A later successful re-analysis overwrites the sentinel through `putCached`'s
 * card write. Only rows that really got a card are counted.
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
    let hit;
    try {
      hit = await getCached(owner, name, SCHEMA_VERSION);
    } catch {
      continue; // Database error, possibly transient: leave card NULL so a later render retries.
    }
    let built: GalleryCard | null = null;
    if (hit) {
      try {
        built = galleryCard(hit.analysis, hit.analysedAt);
      } catch {
        built = null;
      }
    }
    if (!built) {
      try {
        await getDb().query(
          `UPDATE analyses SET card = '{}'::jsonb WHERE owner = $1 AND name = $2 AND schema_version = $3`,
          [owner, name, SCHEMA_VERSION],
        );
      } catch {
        // Best effort: the row stays card-less and is retried on a later render.
      }
      continue;
    }
    try {
      await putCard(owner, name, SCHEMA_VERSION, built);
      filled++;
    } catch {
      // Database error, possibly transient: leave card NULL so a later render retries.
    }
  }
  return filled;
}
