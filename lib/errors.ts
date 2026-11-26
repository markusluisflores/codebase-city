// No server-only imports here: the viewer UI (client bundle) uses `errorMessage`. The GitHub and cap
// code lists are checked against this table in tests/errors.test.ts (runtime and compile time); the
// Sandbox list lives here and `lib/sandbox/*` derive their types and sets from it.

/** From `lib/repo/github.ts` (`GitHubErrorCode`, `CapErrorCode`). */
export const GITHUB_CODES = [
  'not_found',
  'github_rate_limited',
  'github_error',
  'bad_response',
  'empty_repo',
  'invalid_commit_date',
] as const;
export const CAP_CODES = [
  'repo_too_large',
  'too_many_commits',
  'too_many_files',
  'tree_truncated',
] as const;
/**
 * The one list of Sandbox failure codes (`lib/sandbox/run.ts` derives `SandboxErrorCode` from it and
 * `lib/sandbox/job.ts` its `JobErrorCode`). `timeout` is added by the runner; the job never reports it.
 */
export const SANDBOX_CODES = [
  'timeout',
  'clone_failed',
  'stale_head',
  'invalid_output',
  'too_many_commits_in_window',
  'too_many_files',
  'bad_argument',
] as const;
/** The codes the Sandbox job itself may report on its stdout: every Sandbox code except the runner's `timeout`. */
export const JOB_REPORTED_CODES = SANDBOX_CODES.filter(
  (c): c is Exclude<(typeof SANDBOX_CODES)[number], 'timeout'> => c !== 'timeout',
);
/** Quota refusals from `reserveQuota` (`lib/db/limits.ts`). */
export const QUOTA_CODES = ['daily', 'monthly'] as const;
/** Per-IP and global analyze limits (`lib/db/limits.ts`): GitHub lookups an hour, live analyses a day. */
export const LIMIT_CODES = ['lookup_limit', 'analysis_limit'] as const;
/** Codes the password gate and the session check return (`lib/login.ts`, `lib/session.ts`). */
export const GATE_CODES = [
  'wrong_password',
  'too_many_attempts',
  'unauthorized',
  'misconfigured',
  'unavailable',
] as const;
/** Codes the API routes themselves return. */
export const API_CODES = [
  'db_write_failed',
  'db_unavailable',
  'internal_error',
  'invalid_repo',
  'invalid_body',
  'unsupported_media_type',
  'job_not_found',
  'analysis_not_found',
] as const;

/** Every error code the product can show. The test fails (and typecheck fails) when a source module gains a code that is not listed here. */
export type ErrorCode =
  | (typeof GITHUB_CODES)[number]
  | (typeof CAP_CODES)[number]
  | (typeof SANDBOX_CODES)[number]
  | (typeof QUOTA_CODES)[number]
  | (typeof LIMIT_CODES)[number]
  | (typeof GATE_CODES)[number]
  | (typeof API_CODES)[number];

/**
 * Spec section 11, plus the codes added since. Messages carry no stack trace, internal path, raw stderr,
 * commit subject or visitor IP. `db_write_failed` differs from the spec on purpose: since 2026-11-16 a
 * run that reached the Sandbox keeps its quota unit, so the message no longer says it did not count.
 */
const MESSAGES: Record<ErrorCode, string> = {
  not_found: "We couldn't find a public GitHub repository with that name.",
  repo_too_large: 'This repository is larger than the 1 GB limit for live analysis.',
  too_many_commits:
    'This repository has more than 50,000 commits, which is over the live analysis limit.',
  too_many_commits_in_window:
    'This repository has more than 20,000 commits in the last 24 months, which is over the live analysis limit.',
  too_many_files:
    'This repository has more than 10,000 files, which is over the live analysis limit.',
  tree_truncated:
    "GitHub returned only part of this repository's file list, so it is too large to analyse live.",
  clone_failed: "We couldn't fetch this repository's history. Please try again.",
  stale_head: 'The repository changed while we were analysing it. Please try again.',
  invalid_output:
    "The analysis produced a result we couldn't use, so nothing was saved. Please try again.",
  timeout: 'The analysis took longer than the 4-minute limit and was stopped.',
  github_rate_limited: 'GitHub is limiting requests right now. Please try again in a few minutes.',
  daily: 'The daily demo limit has been reached. Please try again tomorrow (UTC).',
  monthly: 'The monthly demo limit has been reached. Please try again next month.',
  db_write_failed: "The analysis finished but we couldn't save it. Please try again later.",
  lookup_limit:
    'Too many repositories have been checked recently. Please try again in a little while.',
  analysis_limit:
    'This connection has reached its daily limit for live analyses. Please try again tomorrow (UTC).',
  wrong_password: 'That password is not correct.',
  too_many_attempts: 'Too many attempts. Wait a minute and try again.',

  github_error: 'GitHub returned an error. Please try again in a few minutes.',
  bad_response: "GitHub returned a response we couldn't read. Please try again later.",
  empty_repo: 'This repository has no commits, so there is nothing to analyse.',
  invalid_commit_date:
    "This repository's latest commit has a date we can't use, so the 24-month window can't be set.",
  bad_argument: "That request wasn't valid, so no analysis was run.",

  unauthorized: 'Enter the demo password to analyse a repository.',
  misconfigured: 'Live analysis is not available right now.',
  unavailable: 'Sign-in is not available right now. Please try again later.',
  db_unavailable: 'The demo database is not available right now. Please try again later.',
  internal_error: 'Something went wrong. Please try again.',
  invalid_repo: 'Enter a public GitHub repository as owner/name or a github.com link.',
  invalid_body: "That request wasn't valid.",
  unsupported_media_type: "That request wasn't valid.",
  job_not_found: "We couldn't find that analysis job.",
  analysis_not_found: "This repo isn't analysed yet. Enter the demo password to analyse it.",
};

export const ERROR_CODES = Object.keys(MESSAGES) as ErrorCode[];

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES, code);
}

/** The user-facing message for a code. An unknown code gets the generic message, never the code's text. */
export function errorMessage(code: string): string {
  return isErrorCode(code) ? MESSAGES[code] : MESSAGES.internal_error;
}

/** The HTTP status for a code returned by an API route. */
export function errorStatus(code: ErrorCode): number {
  switch (code) {
    case 'not_found':
    case 'job_not_found':
    case 'analysis_not_found':
      return 404;
    case 'repo_too_large':
    case 'too_many_commits':
    case 'too_many_files':
    case 'tree_truncated':
    case 'empty_repo':
    case 'invalid_commit_date':
      return 422;
    case 'daily':
    case 'monthly':
    case 'lookup_limit':
    case 'analysis_limit':
    case 'github_rate_limited':
    case 'too_many_attempts':
      return 429;
    case 'invalid_repo':
    case 'invalid_body':
    case 'bad_argument':
      return 400;
    case 'unsupported_media_type':
      return 415;
    case 'unauthorized':
    case 'wrong_password':
      return 401;
    case 'github_error':
    case 'bad_response':
      return 502;
    case 'db_unavailable':
    case 'misconfigured':
    case 'unavailable':
      return 503;
    default:
      return 500;
  }
}
