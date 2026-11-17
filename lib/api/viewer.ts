import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';
import { getCached } from '@/lib/db/cache';
import { readGallery } from '@/lib/gallery';
import { validateOwnerName } from '@/lib/repo/validate';
import { apiError, streamEnvelope } from './response';

export interface ViewerDeps {
  gallery?: (owner: string, name: string) => Promise<Analysis | null>;
}

/**
 * Cached for the CDN so the public path cannot be used to hammer the database: a stored analysis can be
 * 8 MB of jsonb that is parsed on every uncached read. A re-analysis shows up within the s-maxage.
 */
export const VIEWER_CACHE = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';
const MISS_CACHE = 'public, max-age=0, s-maxage=30';

/**
 * GET /api/analysis/:owner/:name. Public. Reads the static gallery, then the Postgres row, and nothing
 * else: it never calls GitHub or the Sandbox. The body is streamed (Vercel's non-streamed response cap is 4.5 MB).
 */
export async function handleViewer(
  owner: string,
  name: string,
  deps: ViewerDeps = {},
): Promise<Response> {
  if (!validateOwnerName(owner) || !validateOwnerName(name)) return apiError('invalid_repo');
  const gallery = await (deps.gallery ?? readGallery)(owner, name);
  if (gallery) {
    return streamEnvelope({ source: 'gallery', analysedAt: null }, gallery, {
      'cache-control': VIEWER_CACHE,
    });
  }
  let row;
  try {
    row = await getCached(owner, name, SCHEMA_VERSION);
  } catch {
    return apiError('db_unavailable');
  }
  if (!row) {
    const res = apiError('analysis_not_found');
    res.headers.set('cache-control', MISS_CACHE);
    return res;
  }
  return streamEnvelope(
    { source: 'live', analysedAt: row.analysedAt.toISOString() },
    row.analysis,
    {
      'cache-control': VIEWER_CACHE,
    },
  );
}
