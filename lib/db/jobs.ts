import { getDb } from './client';
import { releaseQuota, reserveQuota, utcDay } from './limits';

export type JobPhase = 'queued' | 'cloning' | 'reading_history' | 'computing' | 'done' | 'failed';

export interface Job {
  id: string;
  owner: string;
  name: string;
  phase: JobPhase;
  errorCode: string | null;
  createdAt: Date;
}

/** A non-terminal job older than this reads as failed `timeout` (design section 6). */
export const JOB_STALE_MS = 5 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHASES: readonly string[] = [
  'queued',
  'cloning',
  'reading_history',
  'computing',
  'done',
  'failed',
];

const keyPart = (s: string): string => s.toLowerCase();

interface JobRow {
  id: string;
  owner: string;
  name: string;
  phase: JobPhase;
  error_code: string | null;
  created_at: Date | string;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    phase: r.phase,
    errorCode: r.error_code,
    createdAt: new Date(r.created_at),
  };
}

/**
 * Moves a non-terminal job to `failed` and, if it holds a unit, gives that unit back to its stored
 * reservation date, all in ONE statement. The row lock plus the non-terminal check mean exactly one
 * caller can win, so the unit is released exactly once however many callers race (the sweep, a
 * status read, the route's own failure path). A job already `done` or `failed` is left alone.
 */
async function failJob(id: string, errorCode: string): Promise<boolean> {
  const rows = await getDb().query(
    `WITH old AS (
       SELECT id, reserved, reserved_on FROM jobs
        WHERE id = $1 AND phase NOT IN ('done', 'failed')
          FOR UPDATE
     ),
     upd AS (
       UPDATE jobs j SET phase = 'failed', error_code = $2, reserved = false
         FROM old WHERE j.id = old.id
       RETURNING j.id, old.reserved AS was_reserved, old.reserved_on AS day
     ),
     rel AS (
       UPDATE usage_counters c SET count = GREATEST(c.count - 1, 0)
         FROM upd
        WHERE upd.was_reserved AND c.period IN ('d:' || upd.day, 'm:' || substr(upd.day, 1, 7))
       RETURNING 1
     )
     SELECT id FROM upd`,
    [id, errorCode],
  );
  return rows.length > 0;
}

async function findActive(owner: string, name: string): Promise<{ id: string } | null> {
  const rows = await getDb().query<{ id: string }>(
    `SELECT id FROM jobs WHERE owner = $1 AND name = $2 AND phase NOT IN ('done', 'failed')`,
    [owner, name],
  );
  return rows[0] ?? null;
}

/**
 * Starts a job for the repo, or reuses the one already in flight. Steps, in order:
 * 1. sweep: a non-terminal row for this repo older than 5 minutes is failed `timeout` (its unit
 *    released if it held one) so it is never reused;
 * 2. insert a new row; the unique partial index on `(owner, name)` over non-terminal rows means a
 *    concurrent loser gets nothing back and re-reads and reuses the winner's id, reserving nothing;
 * 3. only the creator reserves quota. If the reservation is refused the new row is failed with the
 *    quota code (`daily` or `monthly`) before returning, so no unreserved non-terminal row survives;
 *    the caller reads that code with `getJob`.
 */
export async function createOrReuseJob(
  owner: string,
  name: string,
  now: Date,
): Promise<{ id: string; reused: boolean }> {
  const db = getDb();
  const o = keyPart(owner);
  const n = keyPart(name);
  const cutoff = new Date(now.getTime() - JOB_STALE_MS).toISOString();

  const stale = await db.query<{ id: string }>(
    `SELECT id FROM jobs WHERE owner = $1 AND name = $2
        AND phase NOT IN ('done', 'failed') AND created_at < $3`,
    [o, n, cutoff],
  );
  for (const s of stale) await failJob(s.id, 'timeout');

  // A concurrent winner can finish between our conflict and our re-read, so retry a few times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = crypto.randomUUID();
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO jobs (id, owner, name, phase, reserved, reserved_on, created_at)
       VALUES ($1, $2, $3, 'queued', false, $4, $5)
       ON CONFLICT (owner, name) WHERE phase NOT IN ('done', 'failed') DO NOTHING
       RETURNING id`,
      [id, o, n, utcDay(now), now.toISOString()],
    );
    if (inserted.length === 0) {
      const active = await findActive(o, n);
      if (active) return { id: active.id, reused: true };
      continue;
    }

    let reservation: Awaited<ReturnType<typeof reserveQuota>>;
    try {
      reservation = await reserveQuota(now);
    } catch (err) {
      // Never leave an unreserved non-terminal row that blocks the repo for five minutes.
      await failJob(id, 'db_write_failed');
      throw err;
    }
    if (!reservation.ok) {
      await failJob(id, reservation.reason);
      return { id, reused: false };
    }
    const marked = await db.query(
      `UPDATE jobs SET reserved = true WHERE id = $1 AND phase NOT IN ('done', 'failed') RETURNING id`,
      [id],
    );
    // The row was failed in between (for example swept): hand the unit back, nothing holds it.
    if (marked.length === 0) await releaseQuota(utcDay(now));
    return { id, reused: false };
  }
  throw new Error('could not create or reuse a job');
}

/**
 * Advances a job. `failed` goes through the single failing statement (releasing the quota once);
 * `done` and the other phases only move a non-terminal row, so a finished job is never reopened.
 */
export async function setJobPhase(id: string, phase: JobPhase, errorCode?: string): Promise<void> {
  if (!PHASES.includes(phase)) throw new Error('invalid job phase');
  if (phase === 'failed') {
    await failJob(id, errorCode ?? 'unknown');
    return;
  }
  await getDb().query(
    `UPDATE jobs SET phase = $2 WHERE id = $1 AND phase NOT IN ('done', 'failed')`,
    [id, phase],
  );
}

/**
 * The job, or null. A non-terminal job older than 5 minutes is stored as failed `timeout` (its unit
 * released against the stored reservation date) before it is returned.
 */
export async function getJob(id: string, now: Date): Promise<Job | null> {
  if (!UUID_RE.test(id)) return null;
  const read = async (): Promise<Job | null> => {
    const rows = await getDb().query<JobRow>(
      `SELECT id, owner, name, phase, error_code, created_at FROM jobs WHERE id = $1`,
      [id],
    );
    return rows[0] ? toJob(rows[0]) : null;
  };
  const job = await read();
  if (!job) return null;
  const terminal = job.phase === 'done' || job.phase === 'failed';
  if (!terminal && now.getTime() - job.createdAt.getTime() > JOB_STALE_MS) {
    await failJob(id, 'timeout');
    return read();
  }
  return job;
}
