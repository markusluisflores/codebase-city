import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as jobsRoute from '@/app/api/jobs/[id]/route';
import { handleJobStatus } from '@/lib/api/jobs';
import { setDb } from '@/lib/db/client';
import { createOrReuseJob, JOB_STALE_MS, setJobPhase } from '@/lib/db/jobs';
import { pgAdapter, useTestDb } from '../helpers/pgliteDb';
import { cookie, stubSessionEnv } from '../helpers/flowHelpers';

let t: Awaited<ReturnType<typeof useTestDb>>;
beforeAll(async () => {
  t = await useTestDb();
});
beforeEach(async () => {
  await t.reset();
  setDb(pgAdapter(t.pg));
  stubSessionEnv();
});
afterEach(() => vi.unstubAllEnvs());

const NOW = new Date('2026-11-16T12:00:00Z');
const UNKNOWN = '6f1c1f0e-0000-4000-8000-000000000000';
const get = async (id: string, signedIn = true) =>
  handleJobStatus(
    new Request(`http://localhost/api/jobs/x`, {
      headers: signedIn ? { cookie: await cookie() } : {},
    }),
    id,
    { now: () => NOW },
  );

describe('GET /api/jobs/:id', () => {
  it('exports only GET on the Node runtime', () => {
    expect(Object.keys(jobsRoute).sort()).toEqual(['GET', 'runtime']);
    expect(jobsRoute.runtime).toBe('nodejs');
  });

  it('is session-gated inside the handler', async () => {
    const { id } = await createOrReuseJob('octo', 'repo', NOW);
    expect((await get(id, false)).status).toBe(401);
  });

  it('returns only phase, error code and message for a live job', async () => {
    const { id } = await createOrReuseJob('octo', 'secret-private-name', NOW);
    const res = await get(id);
    const body = await res.json();
    expect(body).toEqual({ phase: 'queued', errorCode: null, message: null });
    expect(JSON.stringify(body)).not.toMatch(/octo|secret-private-name|created/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns a fixed code and message for a failed job; a stored unknown code reads as internal_error', async () => {
    const { id } = await createOrReuseJob('octo', 'repo', NOW);
    await setJobPhase(id, 'failed', 'stale_head');
    expect(await (await get(id)).json()).toMatchObject({
      phase: 'failed',
      errorCode: 'stale_head',
    });
    await t.pg.query(`UPDATE jobs SET error_code = 'raw: ECONNREFUSED 10.0.0.1'`);
    const body = await (await get(id)).json();
    expect(body.errorCode).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('shows a job older than the stale threshold as failed timeout', async () => {
    const { id } = await createOrReuseJob(
      'octo',
      'repo',
      new Date(NOW.getTime() - JOB_STALE_MS - 1000),
    );
    expect(await (await get(id)).json()).toMatchObject({ phase: 'failed', errorCode: 'timeout' });
  });

  it.each([
    'not-a-uuid',
    '',
    `${UNKNOWN}' OR '1'='1`,
    UNKNOWN.toUpperCase(),
    '../../etc/passwd',
    UNKNOWN.slice(0, -1),
    `${UNKNOWN}0`,
  ])('a malformed id %j and an unknown id give the same 404', async (id) => {
    const unknown = await get(UNKNOWN);
    const res = await get(id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(await unknown.json());
  });

  it('a database failure is a fixed 503', async () => {
    setDb({
      query: async () => {
        throw new Error('postgres://u:hunter2@h/db down');
      },
    });
    const res = await get(UNKNOWN);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toMatch(/hunter2|postgres/);
  });
});
