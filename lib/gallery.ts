import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAnalysis, SCHEMA_VERSION } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';
import { galleryCard, type GalleryCard } from '@/lib/gallery-cards';
import { isGitHubOwner } from '@/lib/repo/url';
import { validateOwnerName } from '@/lib/repo/validate';

/** `public/gallery/<owner>__<repo>.json`, written by `scripts/build-gallery.ts`. */
export const GALLERY_DIR = join(process.cwd(), 'public', 'gallery');

/**
 * The static gallery analysis for a repo, or null (no gallery, no file, an unreadable or out-of-date
 * file). Names are validated first and the file is found by listing the directory and comparing
 * case-insensitively, so user input never becomes a path.
 */
export async function readGallery(
  owner: string,
  name: string,
  dir: string = GALLERY_DIR,
): Promise<Analysis | null> {
  if (!isGitHubOwner(owner) || !validateOwnerName(name)) return null;
  const want = `${owner}__${name}.json`.toLowerCase();
  try {
    const hit = (await readdir(/*turbopackIgnore: true*/ dir)).find(
      (f) => f.toLowerCase() === want,
    );
    if (!hit) return null;
    const analysis = parseAnalysis(
      JSON.parse(await readFile(join(/*turbopackIgnore: true*/ dir, hit), 'utf8')),
    );
    return analysis.schemaVersion === SCHEMA_VERSION ? analysis : null;
  } catch {
    return null;
  }
}

/**
 * One card per analysis in the gallery directory, sorted by repo name. A missing directory or an
 * unreadable, invalid or out-of-date file is skipped (the home page then shows what it can).
 */
export async function listGalleryCards(dir: string = GALLERY_DIR): Promise<GalleryCard[]> {
  let names: string[];
  try {
    names = (await readdir(/*turbopackIgnore: true*/ dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const cards: GalleryCard[] = [];
  for (const file of names.sort()) {
    try {
      const analysis = parseAnalysis(
        JSON.parse(await readFile(join(/*turbopackIgnore: true*/ dir, file), 'utf8')),
      );
      if (analysis.schemaVersion === SCHEMA_VERSION) cards.push(galleryCard(analysis));
    } catch {
      // Skip a bad file rather than break the home page.
    }
  }
  return cards;
}
