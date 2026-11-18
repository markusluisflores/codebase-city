/** Small pure helpers for the viewer's text. */

/** 0 to 1 as a whole-number percentage; 0 is "0%", never blank. */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** The hover text for a single-owner district. */
export function districtTooltip(badge: { ownerName: string; share: number }): string {
  return `single owner: ${badge.ownerName} (${percent(badge.share)})`;
}

/** Unix seconds as a UTC date, `yyyy-mm-dd`. */
export function formatDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Case-insensitive substring search over paths. File-name matches come before matches that are only
 * in a folder name; ties keep the input order.
 */
export function searchPaths(paths: readonly string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const byName: string[] = [];
  const byFolder: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (!lower.includes(q)) continue;
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    (name.includes(q) ? byName : byFolder).push(p);
  }
  return [...byName, ...byFolder].slice(0, limit);
}

/** `1.2 KB` style size, 1024-based. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

const DAY = 86_400;

/** "today", "1 day ago", "3 days ago", then months and years, measured from `now` (both unix seconds). */
export function formatAge(unixSeconds: number, now: number): string {
  const days = Math.max(0, Math.floor((now - unixSeconds) / DAY));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
