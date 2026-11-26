import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  errorMessage,
  errorStatus,
  GATE_CODES,
  JOB_REPORTED_CODES,
  LIMIT_CODES,
  QUOTA_CODES,
  SANDBOX_CODES,
  type ErrorCode,
} from '@/lib/errors';
import {
  CAP_ERROR_CODES,
  GITHUB_ERROR_CODES,
  type CapErrorCode,
  type GitHubErrorCode,
} from '@/lib/repo/github';
import type { SandboxErrorCode } from '@/lib/sandbox/run';

// Compile-time: a code added to a source union that errors.ts does not list fails typecheck here.
const _github: GitHubErrorCode extends ErrorCode ? true : never = true;
const _cap: CapErrorCode extends ErrorCode ? true : never = true;
const _sandbox: SandboxErrorCode extends ErrorCode ? true : never = true;
void [_github, _cap, _sandbox];

const SPEC_11: Record<string, string> = {
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
  wrong_password: 'That password is not correct.',
  too_many_attempts: 'Too many attempts. Wait a minute and try again.',
};

describe('limit codes', () => {
  it('are 429s with fixed messages that state no number and no IP', () => {
    for (const code of LIMIT_CODES) {
      expect(errorStatus(code)).toBe(429);
      expect(errorMessage(code)).not.toMatch(/\d/);
    }
  });
});

describe('errorMessage', () => {
  it('returns the exact spec section 11 message for each of its codes', () => {
    for (const [code, msg] of Object.entries(SPEC_11)) expect(errorMessage(code)).toBe(msg);
  });

  it('db_write_failed no longer claims the run did not count (the refund line moved)', () => {
    expect(errorMessage('db_write_failed')).not.toMatch(/did not count/i);
  });

  it('has a message for every code in every source module', () => {
    const all = [
      ...GITHUB_ERROR_CODES,
      ...CAP_ERROR_CODES,
      ...SANDBOX_CODES,
      ...QUOTA_CODES,
      ...LIMIT_CODES,
      ...GATE_CODES,
    ];
    for (const code of all) {
      expect(ERROR_CODES, code).toContain(code);
      expect(errorMessage(code).length, code).toBeGreaterThan(10);
    }
  });

  it('the job-reported codes are the Sandbox codes minus timeout, and each is a known code', () => {
    expect([...JOB_REPORTED_CODES].sort()).toEqual(
      SANDBOX_CODES.filter((c) => c !== 'timeout').sort(),
    );
    for (const code of JOB_REPORTED_CODES) expect(ERROR_CODES).toContain(code);
  });

  it('no message has a stack trace, internal path, drive letter or a raw value', () => {
    for (const code of ERROR_CODES) {
      const m = errorMessage(code);
      expect(m, code).not.toMatch(/\bat .+\(.+:\d+/);
      expect(m, code).not.toMatch(/\/var\/|node_modules|\/vercel\/|[A-Za-z]:\\/);
      expect(m, code).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    }
  });

  it('an unknown or hostile code gets the generic message, never an echo', () => {
    for (const bad of ['', 'nope', '__proto__', 'constructor', 'toString', 'x'.repeat(500)]) {
      expect(errorMessage(bad)).toBe(errorMessage('internal_error'));
    }
  });

  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) {
      const s = errorStatus(code as ErrorCode);
      expect(s).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThan(600);
    }
  });
});
