import { describe, expect, it } from 'vitest';
import { treemap2D } from '@/lib/layout/treemap';
import { districtBounds, hitRect } from '@/lib/render/treemapDraw';

const files = [
  { path: 'a/x.ts', size: 10 },
  { path: 'a/y.ts', size: 30 },
  { path: 'a/b/z.ts', size: 20 },
  { path: 'c/w.ts', size: 40 },
];

describe('hitRect', () => {
  const rects = treemap2D(files, 100, 100);

  it('finds the rectangle under a point and null outside the container', () => {
    for (const r of rects) expect(hitRect(rects, r.x + r.w / 2, r.y + r.h / 2)?.path).toBe(r.path);
    expect(hitRect(rects, -1, 5)).toBeNull();
    expect(hitRect(rects, 100.5, 5)).toBeNull();
  });
  it('returns null for no rectangles', () => {
    expect(hitRect([], 1, 1)).toBeNull();
  });
});

describe('districtBounds', () => {
  const rects = treemap2D(files, 100, 100);

  it('bounds every rectangle under a flagged folder, at depth 1 or 2', () => {
    const [box] = districtBounds(rects, new Set(['a']));
    const under = rects.filter((r) => r.path.startsWith('a/'));
    expect(box!.x).toBeCloseTo(Math.min(...under.map((r) => r.x)));
    expect(box!.x + box!.w).toBeCloseTo(Math.max(...under.map((r) => r.x + r.w)));
    const nested = districtBounds(rects, new Set(['a/b']));
    expect(nested).toHaveLength(1);
    expect(nested[0]!.path).toBe('a/b');
  });
  it('returns nothing when no district is flagged', () => {
    expect(districtBounds(rects, new Set())).toEqual([]);
  });
});
