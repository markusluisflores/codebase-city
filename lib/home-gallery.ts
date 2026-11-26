import { backfillCards, listLiveCards } from '@/lib/db/cards';
import { listGalleryCards } from '@/lib/gallery';
import type { GalleryCard } from '@/lib/gallery-cards';

/** Most cards the home page shows: all curated ones first, then live analyses, newest first. */
export const HOME_CARD_CAP = 24;
/** Cards built from a full analysis per render, for rows that have none yet. */
const BACKFILL_PER_RENDER = 2;

const key = (c: GalleryCard): string => `${c.owner}/${c.name}`.toLowerCase();

/**
 * Curated cards first (as given), then live cards (as given, newest first) whose repo is not curated
 * (curated wins; the comparison ignores case), at most `cap` in all.
 */
export function mergeCards(
  curated: readonly GalleryCard[],
  live: readonly GalleryCard[],
  cap: number = HOME_CARD_CAP,
): GalleryCard[] {
  const seen = new Set<string>();
  const out: GalleryCard[] = [];
  for (const c of [...curated, ...live]) {
    if (out.length >= cap) break;
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export interface HomeDeps {
  curated?: () => Promise<GalleryCard[]>;
  live?: (limit: number) => Promise<GalleryCard[]>;
  backfill?: (limit: number) => Promise<number>;
}

/**
 * The home page's cards. The curated set never depends on the database: with no `DATABASE_URL`, an
 * unmigrated table or any database error the page shows the curated gallery alone, with no error.
 */
export async function loadHomeCards(deps: HomeDeps = {}): Promise<GalleryCard[]> {
  const curated = await (deps.curated ?? listGalleryCards)();
  if (curated.length >= HOME_CARD_CAP) return mergeCards(curated, []);
  let live: GalleryCard[] = [];
  try {
    // Cards for older rows are built first so a freshly migrated database shows them on this render.
    await (deps.backfill ?? backfillCards)(BACKFILL_PER_RENDER).catch(() => 0);
    // Fetch the cap, not the free slots: curated duplicates are dropped after the query.
    live = await (deps.live ?? listLiveCards)(HOME_CARD_CAP);
  } catch {
    live = [];
  }
  return mergeCards(curated, live);
}
