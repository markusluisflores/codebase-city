import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAnalysis, SCHEMA_VERSION } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';
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
  if (!validateOwnerName(owner) || !validateOwnerName(name)) return null;
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
