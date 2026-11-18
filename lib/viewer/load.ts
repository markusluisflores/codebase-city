import type { Analysis } from '@/lib/analysis/types';

/**
 * What the viewer page is showing. `code` is an API error code, or one of two client-side codes:
 * `network` (no reply) and `unreadable` (a reply that was not the expected JSON). `ErrorState` shows each.
 */
export type ViewerState =
  | { kind: 'loading' }
  | { kind: 'ready'; analysis: Analysis; source: 'gallery' | 'live'; analysedAt: string | null }
  | { kind: 'notFound' }
  | { kind: 'error'; code: string; message: string };

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Lower-case owner and repo, the form `/api/analysis` redirects to. */
export function canonicalRepo(owner: string, name: string): { owner: string; name: string } {
  return { owner: owner.toLowerCase(), name: name.toLowerCase() };
}

interface Envelope {
  source: 'gallery' | 'live';
  analysedAt: string | null;
  analysis: Analysis;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// The body comes from our own API, which only serves validated analyses, so this is a shape check
// rather than the full schema (which uses Node's Buffer and is not meant for the browser bundle).
function isEnvelope(v: unknown): v is Envelope {
  if (!isObject(v)) return false;
  const a = v.analysis;
  return (
    (v.source === 'gallery' || v.source === 'live') &&
    (v.analysedAt === null || typeof v.analysedAt === 'string') &&
    isObject(a) &&
    isObject(a.repo) &&
    isObject(a.window) &&
    isObject(a.stats) &&
    isObject(a.report) &&
    Array.isArray(a.files) &&
    Array.isArray(a.districts)
  );
}

/** Loads the stored analysis from the public route and maps every outcome to a `ViewerState`. */
export async function loadAnalysis(
  owner: string,
  name: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
  signal?: AbortSignal,
): Promise<ViewerState> {
  const c = canonicalRepo(owner, name);
  let res: Response;
  try {
    res = await fetcher(
      `/api/analysis/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.name)}`,
      { signal },
    );
  } catch {
    return { kind: 'error', code: 'network', message: 'Could not reach the server.' };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', code: 'unreadable', message: 'The server sent an unreadable reply.' };
  }
  if (!res.ok) {
    const code = isObject(body) && typeof body.error === 'string' ? body.error : 'unreadable';
    if (res.status === 404 && code === 'analysis_not_found') return { kind: 'notFound' };
    const message =
      isObject(body) && typeof body.message === 'string' ? body.message : 'Something went wrong.';
    return { kind: 'error', code, message };
  }
  if (!isEnvelope(body)) {
    return { kind: 'error', code: 'unreadable', message: 'The server sent an unexpected reply.' };
  }
  return {
    kind: 'ready',
    analysis: body.analysis,
    source: body.source,
    analysedAt: body.analysedAt,
  };
}
