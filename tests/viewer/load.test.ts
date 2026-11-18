import { describe, expect, it, vi } from 'vitest';
import { canonicalRepo, loadAnalysis } from '@/lib/viewer/load';
import { sampleAnalysis } from '../helpers/sampleAnalysis';

const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

describe('canonicalRepo', () => {
  it('lower-cases owner and repo, as the API redirects', () => {
    expect(canonicalRepo('Octo', 'RePo')).toEqual({ owner: 'octo', name: 'repo' });
  });
});

describe('loadAnalysis', () => {
  it('requests the canonical route and returns ready', async () => {
    const analysis = sampleAnalysis('octo', 'repo');
    const fetcher = vi.fn(() =>
      json({ source: 'live', analysedAt: '2026-11-14T10:00:00.000Z', analysis }),
    );
    const state = await loadAnalysis('Octo', 'Repo', fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/analysis/octo/repo', expect.anything());
    expect(state).toEqual({
      kind: 'ready',
      analysis,
      source: 'live',
      analysedAt: '2026-11-14T10:00:00.000Z',
    });
  });

  it('maps 404 analysis_not_found to notFound', async () => {
    const fetcher = () => json({ error: 'analysis_not_found', message: 'x' }, 404);
    expect(await loadAnalysis('a', 'b', fetcher)).toEqual({ kind: 'notFound' });
  });

  it('maps other API errors to error with the code', async () => {
    const fetcher = () => json({ error: 'db_unavailable', message: 'down' }, 503);
    expect(await loadAnalysis('a', 'b', fetcher)).toMatchObject({
      kind: 'error',
      code: 'db_unavailable',
    });
  });

  it('maps a network failure and a malformed body to error', async () => {
    const boom = () => Promise.reject(new Error('offline'));
    expect(await loadAnalysis('a', 'b', boom)).toMatchObject({ kind: 'error', code: 'network' });
    const bad = () => json({ hello: 1 });
    expect(await loadAnalysis('a', 'b', bad)).toMatchObject({
      kind: 'error',
      code: 'bad_response',
    });
  });
});
