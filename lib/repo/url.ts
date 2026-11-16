import { validateOwnerName } from './validate';

const MAX_INPUT = 300;
// Optional scheme, optional www., then github.com (host compared case-insensitively),
// then exactly owner/name, optionally `.git`, optionally `/tree/<ref>` or a trailing `/`.
// The segments are captured loosely and validated afterwards with `validateOwnerName`.
const URL_FORM =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?(?:\/|\/tree\/[A-Za-z0-9._\-/]+)?$/i;
const BARE_FORM = /^([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?\/?$/;
// GitHub user and organisation names never contain `.` or `_`, so the parser is stricter
// than `validateOwnerName` for the owner (this also keeps `github.com/o` from parsing as owner "github.com").
const GITHUB_OWNER = /^[A-Za-z0-9-]{1,39}$/;

/**
 * Turns pasted text into a validated `{owner, name}` for a public github.com repository, or
 * `null`. Accepts `owner/repo` and github.com URLs (http or https, optional `www.`, `.git`,
 * `/tree/<ref>`). Anything else is rejected: other hosts, userinfo, ports, query strings,
 * shell metacharacters, option-like names. The output is only ever used to build URLs and
 * argv entries by our own code, never passed through from the input.
 */
export function parseRepoInput(input: string): { owner: string; name: string } | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_INPUT) return null;
  // Control characters (including newlines) anywhere are a reject, even though `\s` is
  // already excluded from the captured segments.
  if (/[\x00-\x1f\x7f]/.test(text)) return null;

  const m = URL_FORM.exec(text) ?? BARE_FORM.exec(text);
  if (!m) return null;
  const [, owner, name] = m as unknown as [string, string, string];
  if (!GITHUB_OWNER.test(owner) || !validateOwnerName(owner) || !validateOwnerName(name)) {
    return null;
  }
  // `owner/r.git` strips one `.git`; a remaining name that still ends in `.git` is unusual but valid.
  return { owner, name };
}
