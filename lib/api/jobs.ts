import { getJob } from '@/lib/db/jobs';
import { errorMessage, isErrorCode } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import { apiError, apiJson } from './response';

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface JobStatusDeps {
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

/**
 * GET /api/jobs/:id. Session-gated like analyze (the handler checks it itself). The id must be a
 * UUID; a malformed id and an unknown id give the same 404, and the body carries only the phase and
 * a fixed error code with its fixed message: no repo name, owner, timestamps or raw error text.
 */
export async function handleJobStatus(
  req: Request,
  id: string,
  deps: JobStatusDeps = {},
): Promise<Response> {
  const denied = await requireSession(req, deps.env);
  if (denied) return denied;
  if (!JOB_ID.test(id)) return apiError('job_not_found');
  let job;
  try {
    job = await getJob(id, (deps.now ?? (() => new Date()))());
  } catch {
    return apiError('db_unavailable');
  }
  if (!job) return apiError('job_not_found');
  const code =
    job.phase === 'failed' ? (isErrorCode(job.errorCode) ? job.errorCode : 'internal_error') : null;
  return apiJson({ phase: job.phase, errorCode: code, message: code ? errorMessage(code) : null });
}
