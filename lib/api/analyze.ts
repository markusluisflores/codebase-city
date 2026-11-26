import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import type { Analysis } from '@/lib/analysis/types';
import { CAPS } from '@/lib/caps';
import { getCached, putCached } from '@/lib/db/cache';
import { createOrReuseJob, getJob, markSandboxStarted, setJobPhase } from '@/lib/db/jobs';
import { isErrorCode, type ErrorCode } from '@/lib/errors';
import { readGallery } from '@/lib/gallery';
import { checkCaps, fetchRepoFacts, GitHubError, type RepoFacts } from '@/lib/repo/github';
import { parseRepoInput } from '@/lib/repo/url';
import { runAnalysisInSandbox, SandboxError, type RunnerDeps } from '@/lib/sandbox/run';
import { ipLimitKey, secondsToNextUtcDay, takeLookup } from '@/lib/db/limits';
import { assertSessionConfig, clientIp, requireSession } from '@/lib/session';
import { apiError, apiJson } from './response';

export interface AnalyzeDeps {
  fetchFacts?: (owner: string, name: string) => Promise<RepoFacts>;
  gallery?: (owner: string, name: string) => Promise<Analysis | null>;
  sandbox?: RunnerDeps;
  /** Runs the long work after the response is sent. Defaults to Next.js `after`. */
  schedule?: (work: () => Promise<void>) => void;
  /** Marks a page stale once an analysis is stored. Defaults to Next.js `revalidatePath`. */
  revalidate?: (path: string) => void;
  now?: () => Date;
  deadlineMs?: number;
  env?: Record<string, string | undefined>;
}

const MAX_BODY_BYTES = 2048;

/** Fixed-code, repo-name-only log line. Never the error object: a driver or GitHub message could carry a secret. */
function logCode(event: string, code: string, repo?: string): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event, code, ...(repo ? { repo } : {}) }));
}

async function readRepoInput(req: Request): Promise<{ owner: string; name: string } | Response> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return apiError('unsupported_media_type');
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return apiError('invalid_body');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return apiError('invalid_body');
  let repo: unknown;
  try {
    repo = (JSON.parse(text) as { repo?: unknown } | null)?.repo;
  } catch {
    return apiError('invalid_body');
  }
  if (typeof repo !== 'string') return apiError('invalid_body');
  return parseRepoInput(repo) ?? apiError('invalid_repo');
}

/**
 * POST /api/analyze (spec section 6). Order: session, content type and body, gallery, lookup limit (per
 * IP and global, taken before anything is spent), GitHub facts, cache hit on the same head SHA, caps,
 * job create-or-reuse (which reserves the per-IP and global quota only for a new job), then the long
 * work in the background. Every failure is a fixed code; the limit codes carry a `Retry-After`.
 */
export async function handleAnalyze(req: Request, deps: AnalyzeDeps = {}): Promise<Response> {
  const denied = await requireSession(req, deps.env);
  if (denied) return denied;

  const parsed = await readRepoInput(req);
  if (parsed instanceof Response) return parsed;
  const now = deps.now ?? (() => new Date());

  // The static gallery is a cache hit: no GitHub call, no quota, no Sandbox.
  const hit = await (deps.gallery ?? readGallery)(parsed.owner, parsed.name);
  if (hit) {
    return apiJson({
      status: 'cached',
      source: 'gallery',
      owner: hit.repo.owner,
      name: hit.repo.name,
      headSha: hit.repo.headSha,
      analysedAt: null,
    });
  }

  // Limits key on the hashed client IP: the session cookie is a timestamp anyone with the password can
  // mint again, so it cannot identify a holder. A throw denies (fail closed) before GitHub is called.
  let ipKey: string;
  try {
    ipKey = ipLimitKey(assertSessionConfig(deps.env ?? process.env).secret, clientIp(req.headers));
    const lookup = await takeLookup(ipKey, now());
    if (!lookup.ok) return apiError('lookup_limit', { 'retry-after': String(lookup.retryAfterS) });
  } catch {
    logCode('limit_failed', 'db_unavailable');
    return apiError('db_unavailable');
  }

  let facts: RepoFacts;
  try {
    facts = await (deps.fetchFacts ?? ((o, n) => fetchRepoFacts(o, n)))(parsed.owner, parsed.name);
  } catch (e) {
    const code: ErrorCode = e instanceof GitHubError ? e.code : 'internal_error';
    logCode('github_failed', code, `${parsed.owner}/${parsed.name}`);
    return apiError(code);
  }
  const repoLabel = `${facts.owner}/${facts.name}`;

  let jobId: string;
  let analysesLeft: number | undefined;
  try {
    const cached = await getCached(facts.owner, facts.name, SCHEMA_VERSION);
    if (cached && cached.analysis.repo.headSha === facts.headSha) {
      return apiJson({
        status: 'cached',
        source: 'live',
        owner: cached.analysis.repo.owner,
        name: cached.analysis.repo.name,
        headSha: cached.analysis.repo.headSha,
        analysedAt: cached.analysedAt.toISOString(),
      });
    }

    const caps = checkCaps(facts);
    if (!caps.ok) return apiError(caps.code);

    const job = await createOrReuseJob(facts.owner, facts.name, now(), ipKey);
    if (job.reused) return apiJson({ status: 'job', id: job.id });
    const created = await getJob(job.id, now());
    if (created?.phase === 'failed') {
      // A refused reservation (per IP, daily or monthly), or a row failed in between.
      const code = created.errorCode;
      if (code === 'analysis_limit') {
        return apiError(code, { 'retry-after': String(secondsToNextUtcDay(now())) });
      }
      return apiError(isErrorCode(code) ? code : 'internal_error');
    }
    jobId = job.id;
    analysesLeft = job.analysesLeft;
  } catch {
    logCode('db_failed', 'db_unavailable', repoLabel);
    return apiError('db_unavailable');
  }

  try {
    (deps.schedule ?? ((work) => after(work)))(() => runLiveJob(jobId, facts, deps));
  } catch {
    // Nothing will ever run this job: fail it now. The Sandbox was never created, so the unit comes back.
    await setJobPhase(jobId, 'failed', 'internal_error').catch(() => undefined);
    logCode('schedule_failed', 'internal_error', repoLabel);
    return apiError('internal_error');
  }
  return apiJson({
    status: 'job',
    id: jobId,
    ...(analysesLeft === undefined ? {} : { analysesLeft }),
  });
}

/**
 * The background work for one job. Quota rule (Markus, 2026-11-16): a failure before the Sandbox exists
 * refunds the unit; once it exists the unit is kept whatever happens (the job row stores
 * `sandbox_started`, so a stale sweep after a killed function does not refund either).
 */
export async function runLiveJob(
  id: string,
  facts: RepoFacts,
  deps: AnalyzeDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const repoLabel = `${facts.owner}/${facts.name}`;
  let sandboxCreated = false;
  let phases: Promise<void> = Promise.resolve();

  const fail = async (code: ErrorCode): Promise<void> => {
    logCode('job_failed', code, repoLabel);
    // A timeout always keeps the unit: the deadline can win while `create()` is still in flight, and a
    // Sandbox created after that is billed even though `onSandboxCreated` never ran in time.
    // Known gap (accepted): if the database is down for both the flag write and this write, the stale
    // sweep later refunds that one unit; an attacker cannot cause it.
    const keepQuota = sandboxCreated || code === 'timeout';
    await setJobPhase(id, 'failed', code, { keepQuota }).catch(() => undefined);
  };

  let analysis: Analysis;
  try {
    analysis = await runAnalysisInSandbox(
      {
        owner: facts.owner,
        name: facts.name,
        headSha: facts.headSha,
        defaultBranch: facts.defaultBranch,
        windowFromUnix: facts.windowFromUnix,
        head: facts.tree,
        deadlineMs: deps.deadlineMs ?? CAPS.analysisDeadlineMs,
        // One update at a time, in order, so the phases a poller sees advance in order.
        onPhase: (p) => {
          phases = phases.then(() => setJobPhase(id, p)).catch(() => undefined);
        },
        onSandboxCreated: () => {
          sandboxCreated = true; // set first: even if storing the flag fails, this run keeps its unit
          return markSandboxStarted(id);
        },
      },
      deps.sandbox,
    );
  } catch (e) {
    await phases;
    await fail(e instanceof SandboxError ? e.code : 'internal_error');
    return;
  }
  await phases;

  // A job already swept to failed (or otherwise finished) must not write a cache row.
  let live: boolean;
  try {
    const job = await getJob(id, now());
    live = job !== null && job.phase !== 'done' && job.phase !== 'failed';
  } catch {
    await fail('db_write_failed');
    return;
  }
  if (!live) return;

  try {
    await putCached(analysis, now());
  } catch {
    await fail('db_write_failed');
    return;
  }
  // The analysis and its home-page card are stored (a re-analysis replaced both): mark the home page
  // stale so the next visit regenerates it instead of waiting out `revalidate = 60`. It runs before the
  // job reads `done`, so a user who follows the finished job to the home page sees the new card.
  // Best effort: an unavailable revalidation (no request scope, a cache error) never fails the job.
  try {
    (deps.revalidate ?? revalidatePath)('/');
  } catch {
    logCode('revalidate_failed', 'internal_error', repoLabel);
  }
  await setJobPhase(id, 'done').catch(() => undefined);
}
