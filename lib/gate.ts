/**
 * True when a request path reaches a gated live-analysis route: `/api/analyze` and `/api/jobs/...`. The path is normalised first
 * (percent-decoded up to twice, with a third round that must find nothing left to decode or the path
 * is treated as gated; dot segments resolved, empty segments dropped, case folded, `;` params cut), so
 * trailing slashes, case, percent-encoding and `//` or `/./` tricks cannot slip past. Anything that
 * cannot be decoded is treated as gated. Gated means every method, not just POST.
 */
export function isGatedPath(pathname: string): boolean {
  let decoded = pathname;
  try {
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (i === 2) return true; // a third decode still changed it, so it was encoded three or more times: hostile
    }
  } catch {
    return true;
  }
  const segments: string[] = [];
  for (const raw of decoded.replace(/\\/g, '/').split('/')) {
    const cleaned = (raw.split(';')[0] ?? '').replace(/\p{Cc}/gu, '').toLowerCase();
    // Resolve dot segments first, then drop trailing dots and spaces (so "analyze." still counts as analyze).
    const seg = cleaned === '.' || cleaned === '..' ? cleaned : cleaned.replace(/[ .]+$/, '');
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  return segments[0] === 'api' && (segments[1] === 'analyze' || segments[1] === 'jobs');
}
