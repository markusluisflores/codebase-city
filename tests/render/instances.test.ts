import { describe, expect, it } from 'vitest';
import { cityLayout } from '@/lib/layout/city';
import { buildingMatrices, cityRadius, districtDepth, plateMatrices } from '@/lib/render/instances';

describe('buildingMatrices', () => {
  it('writes one column-major translate+scale matrix per building', () => {
    const m = buildingMatrices([{ path: 'a', x: 3, z: -4, footprint: 0.8, height: 5 }]);
    expect(m).toHaveLength(16);
    expect(Array.from(m)).toEqual(
      [0.8, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0.8, 0, 3, 0, -4, 1].map((v) => Math.fround(v)),
    );
  });

  it('sizes the array to the number of buildings, not a fixed cap', () => {
    const layout = cityLayout(
      Array.from({ length: 7 }, (_, i) => ({ path: `d/f${i}.ts`, size: i + 1 })),
    );
    expect(buildingMatrices(layout.buildings)).toHaveLength(layout.buildings.length * 16);
    expect(buildingMatrices([])).toHaveLength(0);
  });
});

describe('plateMatrices', () => {
  it('puts depth-2 plates above depth-1 plates and keeps both at or below ground', () => {
    expect(districtDepth('src')).toBe(1);
    expect(districtDepth('src/lib')).toBe(2);
    expect(districtDepth('src/(files)')).toBe(2);
    const m = plateMatrices([
      { path: 'src', x: 0, z: 0, w: 10, d: 10 },
      { path: 'src/lib', x: 0, z: 0, w: 4, d: 4 },
    ]);
    const top = (i: number) => m[i * 16 + 13]! + m[i * 16 + 5]! / 2;
    expect(top(1)).toBeGreaterThan(top(0));
    expect(top(1)).toBeLessThanOrEqual(0);
  });
});

describe('cityRadius', () => {
  it('is at least 1 for an empty city and covers every building', () => {
    expect(cityRadius({ buildings: [], districts: [] })).toBe(1);
    const layout = cityLayout(
      Array.from({ length: 30 }, (_, i) => ({ path: `d${i % 3}/f${i}.ts`, size: i + 1 })),
    );
    const r = cityRadius(layout);
    for (const b of layout.buildings) expect(Math.abs(b.x)).toBeLessThanOrEqual(r);
  });
});
