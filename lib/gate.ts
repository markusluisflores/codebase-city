/**
 * True when a request path reaches the gated live-analysis route. The path is normalised first
 * (decoded up to twice, dot segments resolved, empty segments dropped, case folded, `;` params cut), so
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
      if (i === 2) return true; // still changing after three rounds: hostile
    }
  } catch {
    return true;
  }
  const segments: string[] = [];
  for (const raw of decoded.replace(/\\/g, '/').split('/')) {
    const seg = (raw.split(';')[0] ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[ .]+$/, '')
      .toLowerCase();
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  return segments[0] === 'api' && segments[1] === 'analyze';
}
