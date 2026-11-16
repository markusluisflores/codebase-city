// Shared by the web function and the Sandbox job. Anchored with \A-style care:
// JS `$` without the `m` flag matches only at the true end, so a trailing newline fails.
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;

const WINDOW_MIN = Date.UTC(2000, 0, 1) / 1000;
const WINDOW_MAX = Date.UTC(2100, 0, 1) / 1000;

/** A GitHub owner or repo name: starts alphanumeric, then letters, digits, `.`, `_`, `-`; at most 100 characters. `.` and `..` fail the first-character rule. */
export function validateOwnerName(s: string): boolean {
  return typeof s === 'string' && OWNER_NAME.test(s);
}

/** A full commit SHA: exactly 40 lower-case hex characters. */
export function validateHeadSha(s: string): boolean {
  return typeof s === 'string' && HEAD_SHA.test(s);
}

/** A window start in unix seconds: an integer between 2000-01-01 and 2100-01-01. */
export function validateWindowFrom(n: number): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= WINDOW_MIN && n <= WINDOW_MAX;
}
