import { getDb } from './client';
import { releaseIpAnalysis, releaseQuota, reserveQuota, takeIpAnalysis, utcDay } from './limits';

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

const FORWARD_ORDER = ['queued', 'cloning', 'reading_history', 'computing', 'done'];

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
 * A job whose Sandbox was created (`sandbox_started`) keeps its unit, and so does a failure the
 * caller says happened after Sandbox creation (`keepQuota`): only a failure before the Sandbox exists
 * refunds. `releaseIfUnreserved` is for the one caller that cannot tell whether its `reserved = true` update
 * committed: the row lock then decides, and the unit goes back once either way.
 */
async function failJob(
  id: string,
  errorCode: string,
  releaseIfUnreserved = false,
  keepQuota = false,
): Promise<boolean> {
  const rows = await getDb().query(
    `WITH old AS (
       SELECT id, reserved, reserved_on, sandbox_started, ip_key FROM jobs
        WHERE id = $1 AND phase NOT IN ('done', 'failed')
          FOR UPDATE
     ),
     upd AS (
       UPDATE jobs j SET phase = 'failed', error_code = $2, reserved = false
         FROM old WHERE j.id = old.id
       RETURNING j.id, old.reserved AS was_reserved, old.reserved_on AS day,
                 old.sandbox_started AS started, old.ip_key AS ip
     ),
     rel AS (
       UPDATE usage_counters c SET count = GREATEST(c.count - 1, 0)
         FROM upd
        WHERE (upd.was_reserved OR $3::boolean) AND NOT upd.started AND NOT $4::boolean
          AND c.period IN ('d:' || upd.day, 'm:' || substr(upd.day, 1, 7))
       RETURNING 1
     ),
     rel_ip AS (
       UPDATE usage_counters c SET count = GREATEST(c.count - 1, 0)
         FROM upd
        WHERE (upd.was_reserved OR $3::boolean) AND NOT upd.started AND NOT $4::boolean
          AND upd.ip IS NOT NULL AND c.period = 'an:' || upd.day || ':ip:' || upd.ip
       RETURNING 1
     )
     SELECT id FROM upd`,
    [id, errorCode, releaseIfUnreserved, keepQuota],
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
 * 2. insert a new row (carrying the caller's hashed IP, if given); the unique partial index on
 *    `(owner, name)` over non-terminal rows means a concurrent loser gets nothing back and re-reads and
 *    reuses the winner's id, reserving nothing;
 * 3. only the creator reserves quota: the caller's per-IP daily unit first (code `analysis_limit`), then
 *    the global daily and monthly units. A refusal fails the new row with its code before returning, so
 *    no unreserved non-terminal row survives; the caller reads that code with `getJob`. A global refusal
 *    gives the per-IP unit back. `analysesLeft` is what the IP has left today after this job.
 */
export async function createOrReuseJob(
  owner: string,
  name: string,
  now: Date,
  ipKey?: string,
): Promise<{ id: string; reused: boolean; analysesLeft?: number }> {
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
      `INSERT INTO jobs (id, owner, name, phase, reserved, reserved_on, created_at, ip_key)
       VALUES ($1, $2, $3, 'queued', false, $4, $5, $6)
       ON CONFLICT (owner, name) WHERE phase NOT IN ('done', 'failed') DO NOTHING
       RETURNING id`,
      [id, o, n, utcDay(now), now.toISOString(), ipKey ?? null],
    );
    if (inserted.length === 0) {
      const active = await findActive(o, n);
      if (active) return { id: active.id, reused: true };
      continue;
    }

    // The per-IP unit is taken first and tracked here until the job row owns it (`reserved = true`).
    let analysesLeft: number | undefined;
    let ipUnitTaken = false;
    const giveIpBack = (): Promise<void> =>
      ipUnitTaken && ipKey
        ? releaseIpAnalysis(utcDay(now), ipKey).catch(() => undefined)
        : Promise.resolve();
    if (ipKey) {
      let ip: Awaited<ReturnType<typeof takeIpAnalysis>>;
      try {
        ip = await takeIpAnalysis(ipKey, now);
      } catch (err) {
        await failJob(id, 'db_write_failed').catch(() => undefined);
        throw err;
      }
      if (!ip.ok) {
        await failJob(id, 'analysis_limit');
        return { id, reused: false };
      }
      ipUnitTaken = true;
      analysesLeft = ip.left;
    }

    let reservation: Awaited<ReturnType<typeof reserveQuota>>;
    try {
      reservation = await reserveQuota(now);
    } catch (err) {
      // Never leave an unreserved non-terminal row that blocks the repo for five minutes.
      await failJob(id, 'db_write_failed');
      await giveIpBack();
      throw err;
    }
    if (!reservation.ok) {
      await failJob(id, reservation.reason);
      await giveIpBack();
      return { id, reused: false };
    }
    let marked: unknown[];
    try {
      marked = await db.query(
        `UPDATE jobs SET reserved = true WHERE id = $1 AND phase NOT IN ('done', 'failed') RETURNING id`,
        [id],
      );
    } catch (err) {
      // Do not leave a queued row that blocks the repo, and do not leak the unit just taken.
      // A throw does not prove the update did not commit (a lost response), so the one failing
      // statement decides: it releases the unit whether or not the mark landed, exactly once
      // (the global units and, through the row's `ip_key`, the per-IP one).
      await failJob(id, 'db_write_failed', true).catch(() => undefined);
      throw err;
    }
    // The row was failed in between (for example swept): hand the units back, nothing holds them.
    if (marked.length === 0) {
      await releaseQuota(utcDay(now));
      await giveIpBack();
    }
    return { id, reused: false, ...(analysesLeft === undefined ? {} : { analysesLeft }) };
  }
  throw new Error('could not create or reuse a job');
}

/**
 * Advances a job. `failed` goes through the single failing statement (releasing the quota once);
 * `done` and the other phases only move a non-terminal row, so a finished job is never reopened.
 */
export async function setJobPhase(
  id: string,
  phase: JobPhase,
  errorCode?: string,
  opts: { keepQuota?: boolean } = {},
): Promise<void> {
  if (!PHASES.includes(phase)) throw new Error('invalid job phase');
  if (phase === 'failed') {
    await failJob(id, errorCode ?? 'unknown', false, opts.keepQuota === true);
    return;
  }
  // Phases only move forward: a late or duplicate update cannot regress a live job.
  await getDb().query(
    `UPDATE jobs SET phase = $2
      WHERE id = $1 AND phase NOT IN ('done', 'failed')
        AND array_position($3::text[], phase) < array_position($3::text[], $2)`,
    [id, phase, FORWARD_ORDER],
  );
}

/**
 * Records that the job's Sandbox exists, so no later failure or stale sweep refunds its quota unit.
 * Only a non-terminal row is touched.
 */
export async function markSandboxStarted(id: string): Promise<void> {
  await getDb().query(
    `UPDATE jobs SET sandbox_started = true WHERE id = $1 AND phase NOT IN ('done', 'failed')`,
    [id],
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
