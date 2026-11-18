import type { Rect } from '@/lib/layout/treemap';

/** Topmost rectangle containing the point, or null. Rectangles from `treemap2D` never overlap. */
export function hitRect(rects: readonly Rect[], x: number, y: number): Rect | null {
  for (const r of rects) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  }
  return null;
}

/** Bounding box of every rectangle under each given folder, for outlining single-owner districts. */
export function districtBounds(
  rects: readonly Rect[],
  districtPaths: ReadonlySet<string>,
): { path: string; x: number; y: number; w: number; h: number }[] {
  const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (const r of rects) {
    const parts = r.path.split('/');
    // A depth-1 and a depth-2 ancestor can both be flagged, so check each prefix.
    for (let depth = 1; depth <= Math.min(2, parts.length - 1); depth++) {
      const folder = parts.slice(0, depth).join('/');
      if (!districtPaths.has(folder)) continue;
      const b = boxes.get(folder);
      if (b) {
        b.x0 = Math.min(b.x0, r.x);
        b.y0 = Math.min(b.y0, r.y);
        b.x1 = Math.max(b.x1, r.x + r.w);
        b.y1 = Math.max(b.y1, r.y + r.h);
      } else boxes.set(folder, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
    }
  }
  return [...boxes.entries()].map(([path, b]) => ({
    path,
    x: b.x0,
    y: b.y0,
    w: b.x1 - b.x0,
    h: b.y1 - b.y0,
  }));
}
