import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import { getCached, putCached } from '@/lib/db/cache';
import { useTestDb } from '../helpers/pgliteDb';
import { sampleAnalysis } from '../helpers/sampleAnalysis';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(() => t.reset());

const T0 = new Date('2026-11-16T10:00:00Z');

describe('analysis cache', () => {
  it('returns null on a miss', async () => {
    expect(await getCached('octo', 'repo', SCHEMA_VERSION)).toBeNull();
  });

  it('round-trips an analysis with its analysedAt and head sha', async () => {
    const a = sampleAnalysis();
    await putCached(a, T0);
    const hit = await getCached('Octo', 'Repo', SCHEMA_VERSION);
    expect(hit?.analysis).toEqual(a);
    expect(hit?.analysedAt.toISOString()).toBe(T0.toISOString());
    expect(hit?.analysis.repo.headSha).toBe('a'.repeat(40));
  });

  it('is keyed by schema version: a row under another version is not returned', async () => {
    await putCached(sampleAnalysis(), T0);
    expect(await getCached('Octo', 'Repo', SCHEMA_VERSION + 1)).toBeNull();
  });

  it('keys owner and name case-insensitively', async () => {
    await putCached(sampleAnalysis('Octo', 'Repo'), T0);
    expect(await getCached('OCTO', 'repo', SCHEMA_VERSION)).not.toBeNull();
  });

  it('replaces the row for a new head sha instead of adding one', async () => {
    await putCached(sampleAnalysis('Octo', 'Repo', 'a'.repeat(40)), T0);
    const later = new Date('2026-11-17T10:00:00Z');
    await putCached(sampleAnalysis('Octo', 'Repo', 'b'.repeat(40)), later);
    const rows = await t.pg.query('SELECT head_sha FROM analyses');
    expect(rows.rows).toHaveLength(1);
    const hit = await getCached('Octo', 'Repo', SCHEMA_VERSION);
    expect(hit?.analysis.repo.headSha).toBe('b'.repeat(40));
    expect(hit?.analysedAt.toISOString()).toBe(later.toISOString());
  });

  it('refuses to store an invalid analysis', async () => {
    const bad = { ...sampleAnalysis(), files: 'nope' } as never;
    await expect(putCached(bad, T0)).rejects.toThrow();
    expect((await t.pg.query('SELECT 1 FROM analyses')).rows).toHaveLength(0);
  });

  it('treats a corrupted row as a miss, not a crash', async () => {
    await putCached(sampleAnalysis(), T0);
    await t.pg.query(`UPDATE analyses SET analysis = '{"schemaVersion":1}'::jsonb`);
    expect(await getCached('Octo', 'Repo', SCHEMA_VERSION)).toBeNull();
  });

  it('treats a row whose body is from another schema version as a miss', async () => {
    await putCached(sampleAnalysis(), T0);
    await t.pg.query(`UPDATE analyses SET analysis = jsonb_set(analysis, '{schemaVersion}', '99')`);
    expect(await getCached('Octo', 'Repo', SCHEMA_VERSION)).toBeNull();
  });

  it('passes a hostile repo name as data, never as SQL', async () => {
    await putCached(sampleAnalysis(), T0);
    expect(await getCached('octo', "x'; DROP TABLE analyses; --", SCHEMA_VERSION)).toBeNull();
    expect((await t.pg.query('SELECT 1 FROM analyses')).rows).toHaveLength(1);
  });
});
