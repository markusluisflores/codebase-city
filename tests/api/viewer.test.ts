import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as viewerRoute from '@/app/api/analysis/[owner]/[name]/route';
import { handleViewer, VIEWER_CACHE } from '@/lib/api/viewer';
import type { Analysis } from '@/lib/analysis/types';
import { putCached } from '@/lib/db/cache';
import { setDb } from '@/lib/db/client';
import { readGallery } from '@/lib/gallery';
import { pgAdapter, useTestDb } from '../helpers/pgliteDb';
import { sampleAnalysis } from '../helpers/sampleAnalysis';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(async () => {
  await t.reset();
  setDb(pgAdapter(t.pg));
});
afterEach(() => vi.restoreAllMocks());

const NOW = new Date('2026-11-16T12:00:00Z');

/** An analysis well over Vercel's 4.5 MB non-streamed response cap, still valid for the schema. */
function bigAnalysis(): Analysis {
  const a = sampleAnalysis('Octo', 'Big');
  const base = a.files[0]!;
  a.files = Array.from({ length: 6000 }, (_, i) => ({
    ...base,
    path: `dir${i % 50}/${String(i).padStart(5, '0')}-${'x'.repeat(800)}.ts`,
  }));
  return a;
}

describe('GET /api/analysis/:owner/:name (public viewer lookup)', () => {
  it('exports only GET on the Node runtime', () => {
    expect(Object.keys(viewerRoute).sort()).toEqual(['GET', 'runtime']);
  });

  it('needs no session, never calls GitHub (fetch) and returns a stored analysis with cache headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await putCached(sampleAnalysis('Octo', 'Repo'), NOW);
    const res = await viewerRoute.GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ owner: 'OCTO', name: 'repo' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ source: 'live', analysedAt: NOW.toISOString() });
    expect(body.analysis.repo.headSha).toBe('a'.repeat(40));
    expect(res.headers.get('cache-control')).toBe(VIEWER_CACHE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves a gallery repo without a database read', async () => {
    setDb({
      query: async () => {
        throw new Error('no database read expected');
      },
    });
    const res = await handleViewer('octo', 'repo', { gallery: async () => sampleAnalysis() });
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe('gallery');
  });

  it('a miss is a briefly cached 404 with a fixed message', async () => {
    const res = await handleViewer('octo', 'nothing-here');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('analysis_not_found');
    expect(res.headers.get('cache-control')).toMatch(/s-maxage=30/);
  });

  it.each(['..', '.', '-x', 'a b', 'a;b', '', 'x'.repeat(101), '%2e%2e'])(
    'rejects the name %j before any database call',
    async (bad) => {
      setDb({
        query: async () => {
          throw new Error('must not be called');
        },
      });
      expect((await handleViewer(bad, 'repo')).status).toBe(400);
      expect((await handleViewer('octo', bad)).status).toBe(400);
    },
  );

  it('streams an analysis over 4.5 MB (no Content-Length) and the body parses', async () => {
    await putCached(bigAnalysis(), NOW);
    const res = await handleViewer('octo', 'big');
    expect(res.headers.get('content-length')).toBeNull();
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(4_500_000);
    const parsed = JSON.parse(new TextDecoder().decode(buf));
    expect(parsed.analysis.files).toHaveLength(6000);
  });

  it('a database failure is a fixed 503 with no raw error', async () => {
    setDb({
      query: async () => {
        throw new Error('postgres://u:hunter2@h/db');
      },
    });
    const res = await handleViewer('octo', 'repo');
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/hunter2|postgres/);
  });
});

describe('readGallery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-'));
  writeFileSync(join(dir, 'Octo__Repo.json'), JSON.stringify(sampleAnalysis('Octo', 'Repo')));
  writeFileSync(
    join(dir, 'old__one.json'),
    JSON.stringify(sampleAnalysis('old', 'one', 'a'.repeat(40), 0)),
  );
  writeFileSync(join(dir, 'bad__json.json'), '{nope');

  it('finds a file case-insensitively; rejects a stale schema, a bad file and a traversal name', async () => {
    expect((await readGallery('octo', 'REPO', dir))?.repo.owner).toBe('Octo');
    expect(await readGallery('old', 'one', dir)).toBeNull();
    expect(await readGallery('bad', 'json', dir)).toBeNull();
    expect(await readGallery('..', 'x', dir)).toBeNull();
    expect(await readGallery('octo', '../Octo__Repo', dir)).toBeNull();
    expect(await readGallery('octo', 'repo', join(dir, 'missing'))).toBeNull();
  });
});
