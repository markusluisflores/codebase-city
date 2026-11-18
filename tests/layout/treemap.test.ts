import { describe, expect, it } from 'vitest';
import { treemap2D } from '@/lib/layout/treemap';

interface F {
  path: string;
  size: number;
}

function files(n: number, size: (i: number) => number = () => 100): F[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `dir${i % 37}/sub${i % 5}/file${i}.ts`,
    size: size(i),
  }));
}

const W = 1000;
const H = 600;

function areaSum(rects: { w: number; h: number }[]): number {
  return rects.reduce((s, r) => s + r.w * r.h, 0);
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  const eps = 1e-6;
  return (
    a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
  );
}

describe('treemap2D', () => {
  it('returns [] for an empty list', () => {
    expect(treemap2D([], W, H)).toEqual([]);
  });

  it('returns [] for a container with no area', () => {
    expect(treemap2D(files(3), 0, H)).toEqual([]);
    expect(treemap2D(files(3), W, -5)).toEqual([]);
  });

  it('gives a single file the whole container', () => {
    const [r, ...rest] = treemap2D([{ path: 'a.ts', size: 5 }], W, H);
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({ path: 'a.ts', x: 0, y: 0, w: W, h: H });
  });

  it('fills the container exactly', () => {
    const rects = treemap2D(
      files(200, (i) => 1 + (i % 17) * 40),
      W,
      H,
    );
    expect(areaSum(rects)).toBeCloseTo(W * H, 3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(W + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(H + 1e-6);
    }
  });

  it('makes area proportional to size', () => {
    const input = files(120, (i) => 50 + (i % 9) * 500);
    const total = input.reduce((s, f) => s + f.size, 0);
    const bySize = new Map(input.map((f) => [f.path, f.size]));
    for (const r of treemap2D(input, W, H)) {
      const expected = ((bySize.get(r.path) ?? 0) / total) * W * H;
      expect(r.w * r.h).toBeCloseTo(expected, 0);
    }
  });

  it('has no overlapping rectangles', () => {
    const rects = treemap2D(
      files(150, (i) => 1 + ((i * 7919) % 1000)),
      W,
      H,
    );
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it('gives zero-size files a minimum area, never NaN', () => {
    const input: F[] = [
      { path: 'a/zero.txt', size: 0 },
      { path: 'a/big.ts', size: 1000 },
      { path: 'b/other.ts', size: 500 },
    ];
    const rects = treemap2D(input, W, H);
    expect(rects).toHaveLength(3);
    const zero = rects.find((r) => r.path === 'a/zero.txt')!;
    expect(zero.w * zero.h).toBeGreaterThan(0);
    for (const r of rects) {
      for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(areaSum(rects)).toBeCloseTo(W * H, 3);
  });

  it('treats NaN, infinite and negative sizes as zero', () => {
    const input: F[] = [
      { path: 'a.ts', size: Number.NaN },
      { path: 'b.ts', size: -10 },
      { path: 'c.ts', size: Number.POSITIVE_INFINITY },
      { path: 'd.ts', size: 10 },
    ];
    const rects = treemap2D(input, W, H);
    expect(rects).toHaveLength(4);
    for (const r of rects) {
      for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(v)).toBe(true);
      expect(r.w * r.h).toBeGreaterThan(0);
    }
  });

  it('gives equal sizes equal areas (duplicate sizes)', () => {
    const rects = treemap2D(files(64), W, H);
    const expected = (W * H) / 64;
    for (const r of rects) expect(r.w * r.h).toBeCloseTo(expected, 3);
  });

  it('handles very skewed sizes', () => {
    const input: F[] = [
      { path: 'huge.bin', size: 1e12 },
      ...Array.from({ length: 50 }, (_, i) => ({ path: `tiny/${i}.txt`, size: 1 })),
      { path: 'zero.txt', size: 0 },
    ];
    const rects = treemap2D(input, W, H);
    expect(rects).toHaveLength(52);
    for (const r of rects) {
      for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(areaSum(rects)).toBeCloseTo(W * H, 2);
  });

  it('keeps unicode and odd paths verbatim and keeps duplicates separate', () => {
    const input: F[] = [
      { path: 'src/日本語/ファイル.ts', size: 10 },
      { path: 'docs/with space/ünï.md', size: 20 },
      { path: 'weird/#?&=%.txt', size: 30 },
      { path: 'dup.ts', size: 5 },
      { path: 'dup.ts', size: 5 },
      { path: '.hidden', size: 1 },
    ];
    const rects = treemap2D(input, W, H);
    expect(rects.map((r) => r.path).sort()).toEqual(input.map((f) => f.path).sort());
  });

  it('caps 10,000 files at 5,000 rectangles and keeps the area exact', () => {
    const input = files(10_000, (i) => 1 + (i % 101));
    const rects = treemap2D(input, W, H);
    expect(rects.length).toBeLessThanOrEqual(5000);
    expect(areaSum(rects)).toBeCloseTo(W * H, 1);
  });

  it('merges the smallest files into one "other" rectangle per folder', () => {
    const input = files(300, (i) => (i === 0 ? 1_000_000 : 1 + (i % 7)));
    const rects = treemap2D(input, W, H, 200);
    expect(rects.length).toBeLessThanOrEqual(200);
    const others = rects.filter((r) => r.path.endsWith('(other)'));
    expect(others.length).toBeGreaterThan(0);
    expect(new Set(others.map((r) => r.path)).size).toBe(others.length);
    expect(rects.some((r) => r.path === input[0]!.path)).toBe(true);
    for (const o of others) expect(o.path).toMatch(/^dir\d+\/sub\d\/\(other\)$/);
    expect(areaSum(rects)).toBeCloseTo(W * H, 2);
  });

  it('does not merge anything at or under the cap', () => {
    const input = files(50);
    const rects = treemap2D(input, W, H, 50);
    expect(rects.map((r) => r.path).sort()).toEqual(input.map((f) => f.path).sort());
  });

  it('lays out 10,000 files well within a generous time bound', () => {
    const input = files(10_000, (i) => 1 + ((i * 31) % 997));
    const start = performance.now();
    treemap2D(input, W, H);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
