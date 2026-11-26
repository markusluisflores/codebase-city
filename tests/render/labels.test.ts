import { describe, expect, it } from 'vitest';
import {
  MAX_LABELS,
  chooseLabels,
  districtFileCounts,
  fitLabel,
  isLabelDistrict,
  labelOpacity,
  screenRect,
  type LabelCandidate,
} from '@/lib/render/labels';

const CHAR = 7;

describe('fitLabel', () => {
  it('keeps the full path when it fits', () => {
    expect(fitLabel('src/util', 8 * CHAR, CHAR)).toBe('src/util');
  });
  it('falls back to the last segment', () => {
    expect(fitLabel('crates/rustfix', 8 * CHAR, CHAR)).toBe('rustfix');
  });
  it('cuts a long segment with an ellipsis', () => {
    expect(fitLabel('testsuite', 6 * CHAR, CHAR)).toBe('tests…');
  });
  it('returns null when fewer than 6 characters fit', () => {
    expect(fitLabel('testsuite', 5 * CHAR, CHAR)).toBeNull();
  });
});

describe('isLabelDistrict', () => {
  const paths = ['src', 'src/util', 'src/(files)', 'docs', '(files)'];
  it('labels leaf districts only, never the "(files)" pseudo-districts', () => {
    expect(paths.filter((p) => isLabelDistrict(p, paths))).toEqual(['src/util', 'docs']);
  });
  it('labels a folder whose only child is a pseudo-district', () => {
    expect(isLabelDistrict('lib', ['lib', 'lib/(files)'])).toBe(true);
  });
});

describe('labelOpacity', () => {
  it('is 0 at the threshold width, 1 from 1.6 times it, and rises between', () => {
    expect(labelOpacity(60, 60)).toBe(0);
    expect(labelOpacity(96, 60)).toBe(1);
    expect(labelOpacity(200, 60)).toBe(1);
    expect(labelOpacity(78, 60)).toBeCloseTo(0.5, 5);
  });
});

const cand = (path: string, x: number, y: number, w: number, h: number): LabelCandidate => ({
  path,
  x,
  y,
  w,
  h,
});

describe('chooseLabels', () => {
  const opts = {
    minWidth: 60,
    minHeight: 16,
    charWidth: CHAR,
    lineHeight: 14,
    anchor: 'topleft' as const,
  };
  it('skips districts below the pixel threshold', () => {
    expect(chooseLabels([cand('a/long', 0, 0, 59, 100)], opts)).toEqual([]);
    expect(chooseLabels([cand('a/long', 0, 0, 100, 15)], opts)).toEqual([]);
  });
  it('lets the larger district win a collision', () => {
    const out = chooseLabels([cand('small', 130, 90, 70, 30), cand('large', 5, 5, 300, 200)], {
      ...opts,
      anchor: 'centre',
    });
    expect(out.map((l) => l.path)).toEqual(['large']);
  });
  it('keeps non-colliding labels and caps the count', () => {
    const many = Array.from({ length: 30 }, (_, i) => cand(`d${i}`, i * 100, 0, 90, 50));
    expect(chooseLabels(many, opts)).toHaveLength(MAX_LABELS);
  });
  it('places topleft labels inside the rectangle and centre labels in the middle', () => {
    const [a] = chooseLabels([cand('abc/def', 100, 50, 200, 100)], opts);
    expect(a!.x).toBeGreaterThan(100);
    expect(a!.y).toBeGreaterThan(50);
    const [b] = chooseLabels([cand('abc/def', 100, 50, 200, 100)], { ...opts, anchor: 'centre' });
    expect(b!.x).toBe(200);
    expect(b!.y).toBe(100);
  });
  it('is deterministic for equal areas (path order)', () => {
    const a = chooseLabels([cand('b', 0, 0, 100, 50), cand('a', 0, 0, 100, 50)], opts);
    expect(a.map((l) => l.path)).toEqual(['a']);
  });
});

describe('districtFileCounts', () => {
  it('counts files under each district path', () => {
    const counts = districtFileCounts(
      ['src', 'src/util', 'docs'],
      ['src/a.ts', 'src/util/b.ts', 'docs/c.md', 'README.md'],
    );
    expect(counts.get('src')).toBe(2);
    expect(counts.get('src/util')).toBe(1);
    expect(counts.get('docs')).toBe(1);
  });
});

describe('screenRect', () => {
  const at = (x: number, y: number, behind = false) => ({ x, y, behind });
  it('maps NDC corners to pixels (y up becomes y down)', () => {
    const r = screenRect([at(-0.5, 0.5), at(0.5, 0.5), at(0.5, -0.5), at(-0.5, -0.5)], 400, 200);
    expect(r).toEqual({ x: 100, y: 50, w: 200, h: 100 });
  });
  it('clamps a district larger than the screen to the viewport', () => {
    const r = screenRect([at(-3, 3), at(3, 3), at(3, -3), at(-3, -3)], 400, 200);
    expect(r).toEqual({ x: 0, y: 0, w: 400, h: 200 });
  });
  it('clips a partly visible district to its visible part', () => {
    const r = screenRect([at(0, 1), at(2, 1), at(2, -1), at(0, -1)], 400, 200);
    expect(r).toEqual({ x: 200, y: 0, w: 200, h: 200 });
  });
  it('returns null when wholly off screen', () => {
    expect(screenRect([at(2, 0), at(3, 0), at(3, 1), at(2, 1)], 400, 200)).toBeNull();
  });
  it('returns null when any corner is behind the camera', () => {
    expect(screenRect([at(0, 0), at(0.5, 0), at(0.5, 0.5, true), at(0, 0.5)], 400, 200)).toBeNull();
  });
});
