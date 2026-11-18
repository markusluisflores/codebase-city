import { describe, expect, it } from 'vitest';
import { cityLayout } from '@/lib/layout/city';
import { arcPoints, arcSegments, arcsFor } from '@/lib/render/arcs';
import { fileStat, viewerAnalysis } from '../helpers/viewerFixture';

const analysis = viewerAnalysis();
const layout = cityLayout(analysis.files);
const a = analysis.files[0]!; // src/a.ts, partner src/b.ts

describe('arcsFor', () => {
  it('is empty when nothing is selected', () => {
    expect(arcsFor(null, layout)).toEqual([]);
    expect(arcsFor(undefined, layout)).toEqual([]);
  });

  it('gives one arc per partner that has a building, rooftop to rooftop', () => {
    const arcs = arcsFor(a, layout);
    expect(arcs).toHaveLength(1);
    const from = layout.buildings.find((b) => b.path === 'src/a.ts')!;
    const to = layout.buildings.find((b) => b.path === 'src/b.ts')!;
    expect(arcs[0]).toMatchObject({
      path: 'src/b.ts',
      from: [from.x, from.height, from.z],
      to: [to.x, to.height, to.z],
      score: 0.5,
    });
    expect(arcs[0]!.apex).toBeGreaterThan(Math.max(from.height, to.height));
  });

  it('skips partners with no building, itself and duplicates', () => {
    const file = fileStat({
      path: 'src/a.ts',
      coChange: [
        { path: 'gone.ts', shared: 3, score: 0.3 },
        { path: 'src/a.ts', shared: 3, score: 0.3 },
        { path: 'src/b.ts', shared: 3, score: 0.3 },
        { path: 'src/b.ts', shared: 3, score: 0.3 },
      ],
    });
    expect(arcsFor(file, layout).map((x) => x.path)).toEqual(['src/b.ts']);
  });

  it('is empty for a file that has no building of its own', () => {
    expect(arcsFor(fileStat({ path: 'not/in/layout.ts' }), layout)).toEqual([]);
  });
});

describe('arc curve', () => {
  const arc = arcsFor(a, layout)[0]!;

  it('runs from one rooftop to the other, passing the apex in the middle', () => {
    const pts = arcPoints(arc, 24);
    expect(pts).toHaveLength(25 * 3);
    arc.from.forEach((v, i) => expect(pts[i]).toBeCloseTo(v, 6));
    arc.to.forEach((v, i) => expect(pts[pts.length - 3 + i]).toBeCloseTo(v, 6));
    expect(pts[12 * 3 + 1]).toBeCloseTo(arc.apex, 6); // the middle of the curve is at the apex
  });

  it('makes two vertices per segment', () => {
    expect(arcSegments(arc, 10)).toHaveLength(10 * 6);
  });
});
