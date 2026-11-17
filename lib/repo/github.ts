import { windowStart } from '../ingest/analyze';
import { CAPS } from '../caps';
import { isGitHubOwner } from './url';
import {
  validateBranchName,
  validateHeadSha,
  validateOwnerName,
  validateWindowFrom,
} from './validate';

/**
 * Error codes from the GitHub pre-checks. The first three are in spec section 11 (`not_found`,
 * `github_rate_limited`); the rest are new and need a message in Task 12b's `errorMessage`:
 * `github_error` (GitHub failed or was unreachable), `bad_response` (a response did not have the
 * shape we rely on), `empty_repo` (no commits), `invalid_commit_date` (latest commit dated before
 * 2002 or in the future: the 24-month window cannot be trusted, so nothing is analysed).
 */
export const GITHUB_ERROR_CODES = [
  'not_found',
  'github_rate_limited',
  'github_error',
  'bad_response',
  'empty_repo',
  'invalid_commit_date',
] as const;
export type GitHubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

/** The message is the code only: no response body, URL, header or token can leak through it. */
export class GitHubError extends Error {
  constructor(readonly code: GitHubErrorCode) {
    super(code);
    this.name = 'GitHubError';
  }
}

export class GitHubRateLimited extends GitHubError {
  constructor() {
    super('github_rate_limited');
    this.name = 'GitHubRateLimited';
  }
}

export interface RepoFacts {
  /** Canonical casing as GitHub reports it (the cache key uses this, not the pasted text). */
  owner: string;
  name: string;
  sizeKb: number;
  /** TOTAL commits on the default branch, from the `Link` header of `commits?per_page=1`. */
  totalCommits: number;
  /** Author-independent: the committer date of the default branch head, unix seconds. */
  latestCommitUnix: number;
  /** 24 months before `latestCommitUnix`, validated; pass it to the Sandbox job unchanged. */
  windowFromUnix: number;
  headSha: string;
  defaultBranch: string;
  /** Blobs only (files at `headSha`), including `.mailmap` with its size when present. */
  tree: { path: string; size: number }[];
  treeTruncated: boolean;
}

export interface GitHubDeps {
  fetch?: typeof fetch;
  /** Defaults to `process.env.GITHUB_TOKEN`; read only here, sent only to api.github.com. */
  token?: string;
  now?: () => Date;
}

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
const SMALL_BODY_MAX = 1024 * 1024;
const TREE_BODY_MAX = 32 * 1024 * 1024;
const MIN_LATEST = Date.UTC(2002, 0, 1) / 1000;
const MAX_FUTURE_SKEW_S = 24 * 60 * 60;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type Json = unknown;
const isObj = (v: Json): v is Record<string, unknown> => typeof v === 'object' && v !== null;

async function getJson(
  url: string,
  deps: Required<Pick<GitHubDeps, 'fetch'>> & { token: string | undefined },
  opts: { maxBytes: number; emptyOn409?: boolean },
): Promise<{ body: Json; link: string | null }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'codebase-city',
  };
  if (deps.token) headers.Authorization = `Bearer ${deps.token}`;

  let res: Response;
  try {
    res = await deps.fetch(url, {
      headers,
      redirect: 'manual', // a moved or renamed repo is not followed: it would change the cache key
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitHubError('github_error');
  }

  const limited =
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' ||
        res.headers.get('retry-after') !== null));
  if (limited) throw new GitHubRateLimited();
  if (res.status === 404 || res.status === 451 || (res.status >= 300 && res.status < 400)) {
    throw new GitHubError('not_found');
  }
  if (res.status === 409 && opts.emptyOn409) throw new GitHubError('empty_repo');
  if (!res.ok) throw new GitHubError('github_error');

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > opts.maxBytes) throw new GitHubError('bad_response');
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new GitHubError('github_error');
  }
  if (Buffer.byteLength(text, 'utf8') > opts.maxBytes) throw new GitHubError('bad_response');
  try {
    return { body: JSON.parse(text) as Json, link: res.headers.get('link') };
  } catch {
    throw new GitHubError('bad_response');
  }
}

/** The page number of `rel="last"` in a `Link` header, or null when there is none. */
function lastPage(link: string | null): number | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    if (!/;\s*rel="last"/.test(part)) continue;
    const m = /[?&]page=(\d{1,9})(?:[&>]|$)/.exec(part);
    if (!m) throw new GitHubError('bad_response');
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n) || n < 1) throw new GitHubError('bad_response');
    return n;
  }
  return null;
}

function commitUnix(commit: Record<string, unknown>, now: Date): number {
  const c = isObj(commit.commit) ? commit.commit : {};
  const committer = isObj(c.committer) ? c.committer : {};
  const text = committer.date;
  if (typeof text !== 'string' || !ISO_DATE.test(text))
    throw new GitHubError('invalid_commit_date');
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new GitHubError('invalid_commit_date');
  const unix = Math.floor(ms / 1000);
  // Never clamp: an out-of-range date would silently give a wrong window and a zero-commit analysis.
  if (unix < MIN_LATEST) throw new GitHubError('invalid_commit_date');
  if (unix > Math.floor(now.getTime() / 1000) + MAX_FUTURE_SKEW_S) {
    throw new GitHubError('invalid_commit_date');
  }
  return unix;
}

/**
 * Metadata, default-branch head, total commit count and the recursive tree for a public repo.
 * Three GitHub API requests, all to api.github.com with URLs built from validated names and a
 * validated head SHA. Nothing from a response is trusted beyond the shape checks here.
 * Errors are `GitHubError`s whose message is the code only.
 */
export async function fetchRepoFacts(
  owner: string,
  name: string,
  deps: GitHubDeps = {},
): Promise<RepoFacts> {
  if (!isGitHubOwner(owner) || !validateOwnerName(name)) throw new GitHubError('not_found');
  const http = {
    fetch: deps.fetch ?? fetch,
    token: deps.token ?? process.env.GITHUB_TOKEN ?? undefined,
  };
  const now = (deps.now ?? (() => new Date()))();
  const base = `${API}/repos/${owner}/${name}`;

  const { body: repo } = await getJson(base, http, { maxBytes: SMALL_BODY_MAX });
  if (!isObj(repo) || typeof repo.full_name !== 'string') throw new GitHubError('bad_response');
  if (repo.private !== false) throw new GitHubError('not_found'); // public repos only
  const [canonOwner, canonName, ...extra] = repo.full_name.split('/');
  if (
    extra.length > 0 ||
    canonOwner === undefined ||
    canonName === undefined ||
    !isGitHubOwner(canonOwner) ||
    !validateOwnerName(canonName)
  ) {
    throw new GitHubError('bad_response');
  }
  if (
    canonOwner.toLowerCase() !== owner.toLowerCase() ||
    canonName.toLowerCase() !== name.toLowerCase()
  ) {
    throw new GitHubError('not_found');
  }
  if (typeof repo.size !== 'number' || !Number.isInteger(repo.size) || repo.size < 0) {
    throw new GitHubError('bad_response');
  }
  if (typeof repo.default_branch !== 'string' || !validateBranchName(repo.default_branch)) {
    throw new GitHubError('bad_response');
  }

  const { body: commits, link } = await getJson(`${base}/commits?per_page=1`, http, {
    maxBytes: SMALL_BODY_MAX,
    emptyOn409: true,
  });
  if (!Array.isArray(commits)) throw new GitHubError('bad_response');
  const head = commits[0];
  if (!isObj(head)) throw new GitHubError('empty_repo');
  if (typeof head.sha !== 'string' || !validateHeadSha(head.sha)) {
    throw new GitHubError('bad_response');
  }
  const latestCommitUnix = commitUnix(head, now);
  const windowFromUnix = windowStart(latestCommitUnix);
  if (!validateWindowFrom(windowFromUnix)) throw new GitHubError('invalid_commit_date');
  const totalCommits = lastPage(link) ?? commits.length;

  const { body: tree } = await getJson(`${base}/git/trees/${head.sha}?recursive=1`, http, {
    maxBytes: TREE_BODY_MAX,
  });
  if (!isObj(tree) || !Array.isArray(tree.tree) || typeof tree.truncated !== 'boolean') {
    throw new GitHubError('bad_response');
  }
  const files: { path: string; size: number }[] = [];
  for (const e of tree.tree as Json[]) {
    if (!isObj(e) || e.type !== 'blob') continue; // directories and submodules are not files
    if (
      typeof e.path !== 'string' ||
      e.path.length === 0 ||
      typeof e.size !== 'number' ||
      !Number.isInteger(e.size) ||
      e.size < 0
    ) {
      throw new GitHubError('bad_response');
    }
    files.push({ path: e.path, size: e.size });
  }

  return {
    owner: canonOwner,
    name: canonName,
    sizeKb: repo.size,
    totalCommits,
    latestCommitUnix,
    windowFromUnix,
    headSha: head.sha,
    defaultBranch: repo.default_branch,
    tree: files,
    treeTruncated: tree.truncated,
  };
}

export const CAP_ERROR_CODES = [
  'repo_too_large',
  'too_many_commits',
  'too_many_files',
  'tree_truncated',
] as const;
export type CapErrorCode = (typeof CAP_ERROR_CODES)[number];
export type CapResult = { ok: true } | { ok: false; code: CapErrorCode };

/**
 * Pre-clone caps. `too_many_commits` is the TOTAL commit count; the in-window cap is the
 * job's. A truncated tree is checked first: its file list and count cannot be trusted.
 */
export function checkCaps(
  facts: Pick<RepoFacts, 'sizeKb' | 'totalCommits' | 'tree' | 'treeTruncated'>,
  caps: Pick<typeof CAPS, 'maxSizeKb' | 'maxTotalCommits' | 'maxFiles'> = CAPS,
): CapResult {
  if (facts.treeTruncated) return { ok: false, code: 'tree_truncated' };
  if (facts.sizeKb > caps.maxSizeKb) return { ok: false, code: 'repo_too_large' };
  if (facts.totalCommits > caps.maxTotalCommits) return { ok: false, code: 'too_many_commits' };
  if (facts.tree.length > caps.maxFiles) return { ok: false, code: 'too_many_files' };
  return { ok: true };
}
