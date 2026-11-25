import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_HEIGHT, MIN_CELL, MIN_HEIGHT, cityLayout } from '@/lib/layout/city';

interface F {
  path: string;
  size: number;
}
type Layout = ReturnType<typeof cityLayout>;
type Building = Layout['buildings'][number];
type District = Layout['districts'][number];

const EPS = 1e-6;

function bigCity(n: number, size: (i: number) => number = (i) => 1 + (i % 97)): F[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `top${i % 23}/mid${i % 7}/deep${i % 3}/file${i}.ts`,
    size: size(i),
  }));
}

function contains(d: District, b: Building): boolean {
  const half = b.footprint / 2;
  return (
    b.x - half >= d.x - d.w / 2 - EPS &&
    b.x + half <= d.x + d.w / 2 + EPS &&
    b.z - half >= d.z - d.d / 2 - EPS &&
    b.z + half <= d.z + d.d / 2 + EPS
  );
}

function expectedDistrictPaths(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const dirs = p.split('/').slice(0, -1);
    if (dirs.length >= 1) out.add(dirs[0]!);
    if (dirs.length >= 2) out.add(`${dirs[0]}/${dirs[1]}`);
  }
  return out;
}

describe('cityLayout', () => {
  it('returns empty output for an empty list', () => {
    expect(cityLayout([])).toEqual({ buildings: [], districts: [] });
  });

  it('puts a lone root file in a "(files)" pseudo-district', () => {
    const l = cityLayout([{ path: 'README.md', size: 10 }]);
    expect(l.buildings).toHaveLength(1);
    expect(l.districts.map((d) => d.path)).toEqual(['(files)']);
    expect(contains(l.districts[0]!, l.buildings[0]!)).toBe(true);
  });

  it('makes districts of depth 1 and 2 only; deeper files belong to their depth-2 district', () => {
    const input: F[] = [
      { path: 'a/b/c/d/e.ts', size: 5 },
      { path: 'a/b/c.ts', size: 5 },
      { path: 'a/x/y.ts', size: 5 },
    ];
    const l = cityLayout(input);
    const paths = l.districts.map((d) => d.path);
    expect(paths).toContain('a');
    expect(paths).toContain('a/b');
    expect(paths).toContain('a/x');
    expect(paths.every((p) => p.split('/').length <= 2)).toBe(true);
    const deep = l.buildings.find((b) => b.path === 'a/b/c/d/e.ts')!;
    expect(
      contains(
        l.districts.find((d) => d.path === 'a/b')!,
        deep,
      ),
    ).toBe(true);
  });

  it('nests every depth-2 district inside its depth-1 parent', () => {
    const l = cityLayout(bigCity(300));
    const nested = l.districts.filter((x) => x.path.split('/').length === 2);
    expect(nested.length).toBeGreaterThan(0);
    for (const d of nested) {
      const parent = l.districts.find((p) => p.path === d.path.split('/')[0])!;
      expect(parent).toBeDefined();
      expect(d.x - d.w / 2).toBeGreaterThanOrEqual(parent.x - parent.w / 2 - EPS);
      expect(d.x + d.w / 2).toBeLessThanOrEqual(parent.x + parent.w / 2 + EPS);
      expect(d.z - d.d / 2).toBeGreaterThanOrEqual(parent.z - parent.d / 2 - EPS);
      expect(d.z + d.d / 2).toBeLessThanOrEqual(parent.z + parent.d / 2 + EPS);
    }
  });

  it('uses "(files)" pseudo-districts for root files and for direct files of a depth-1 folder with subfolders', () => {
    const input: F[] = [
      { path: 'README.md', size: 1 },
      { path: 'src/index.ts', size: 1 },
      { path: 'src/lib/util.ts', size: 1 },
      { path: 'docs/guide.md', size: 1 },
    ];
    const l = cityLayout(input);
    const paths = l.districts.map((d) => d.path);
    expect(paths).toContain('(files)');
    expect(paths).toContain('src/(files)');
    expect(paths).toContain('src/lib');
    expect(paths).toContain('docs');
    expect(paths).not.toContain('docs/(files)');
    const idx = l.buildings.find((b) => b.path === 'src/index.ts')!;
    expect(
      contains(
        l.districts.find((d) => d.path === 'src/(files)')!,
        idx,
      ),
    ).toBe(true);
    const guide = l.buildings.find((b) => b.path === 'docs/guide.md')!;
    expect(
      contains(
        l.districts.find((d) => d.path === 'docs')!,
        guide,
      ),
    ).toBe(true);
  });

  it('includes every depth-1 and depth-2 folder path as a district', () => {
    const input = bigCity(500);
    const have = new Set(cityLayout(input).districts.map((d) => d.path));
    for (const p of expectedDistrictPaths(input.map((f) => f.path))) expect(have.has(p)).toBe(true);
  });

  it('does not lose root files when a real folder is named "(files)"', () => {
    const l = cityLayout([
      { path: 'README.md', size: 1 },
      { path: '(files)/x/y.ts', size: 1 },
      { path: '(files)/z.ts', size: 1 },
    ]);
    expect(l.buildings.map((b) => b.path).sort()).toEqual([
      '(files)/x/y.ts',
      '(files)/z.ts',
      'README.md',
    ]);
  });

  it('keeps each building inside its own leaf district and sibling leaf districts apart', () => {
    const input = bigCity(2000);
    const l = cityLayout(input);
    const byPath = new Map(l.districts.map((d) => [d.path, d]));
    for (const b of l.buildings) {
      const leaf = b.path.split('/').slice(0, 2).join('/');
      expect(contains(byPath.get(leaf)!, b)).toBe(true);
    }
    const leaves = [...expectedDistrictPaths(input.map((f) => f.path))]
      .filter((p) => p.includes('/'))
      .map((p) => byPath.get(p)!);
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i]!;
        const b = leaves[j]!;
        const apartX = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - EPS;
        const apartZ = Math.abs(a.z - b.z) >= (a.d + b.d) / 2 - EPS;
        expect(apartX || apartZ).toBe(true);
      }
    }
  });

  it('puts every building inside some district', () => {
    const l = cityLayout(bigCity(400));
    for (const b of l.buildings) expect(l.districts.some((d) => contains(d, b))).toBe(true);
  });

  it('gives all buildings the same footprint and equal-size files equal heights', () => {
    const input = Array.from({ length: 80 }, (_, i) => ({ path: `d${i % 4}/f${i}.ts`, size: 100 }));
    const l = cityLayout(input);
    expect(new Set(l.buildings.map((b) => b.footprint)).size).toBe(1);
    expect(new Set(l.buildings.map((b) => b.height)).size).toBe(1);
  });

  it('scales height with the square root of size', () => {
    const l = cityLayout([
      { path: 'a/zero.ts', size: 0 },
      { path: 'a/small.ts', size: 100 },
      { path: 'a/large.ts', size: 400 },
    ]);
    const h = (p: string) => l.buildings.find((b) => b.path === p)!.height;
    expect(h('a/large.ts')).toBeGreaterThan(h('a/small.ts'));
    expect(h('a/small.ts')).toBeGreaterThan(h('a/zero.ts'));
    expect((h('a/large.ts') - h('a/zero.ts')) / (h('a/small.ts') - h('a/zero.ts'))).toBeCloseTo(
      2,
      6,
    );
  });

  describe('height scale with an outlier file', () => {
    const cell = (l: Layout): number => l.buildings[0]!.footprint / 0.8;
    const heightsInCells = (l: Layout): number[] => l.buildings.map((b) => b.height / cell(l));
    // Cargo-like: 3,000 small files (a few hundred bytes to ~50 KB) plus one 2.4 MB blob.
    const cargoLike = (): F[] => [
      ...Array.from({ length: 3000 }, (_, i) => ({
        path: `d${i % 20}/f${i}.rs`,
        size: 100 + ((i * 7919) % 20_000),
      })),
      { path: 'benches/blob.txt', size: 2_449_408 },
    ];

    it('does not flatten typical buildings: the median is well above the minimum height', () => {
      const hs = heightsInCells(cityLayout(cargoLike())).sort((a, b) => a - b);
      expect(hs[Math.floor(hs.length / 2)]!).toBeGreaterThan(MIN_HEIGHT * 3);
    });

    it('draws the outlier and every file above the reference at exactly the maximum height', () => {
      const l = cityLayout(cargoLike());
      const hs = heightsInCells(l);
      const blob = l.buildings.find((b) => b.path === 'benches/blob.txt')!;
      expect(blob.height / cell(l)).toBeCloseTo(MAX_HEIGHT, 9);
      expect(Math.max(...hs)).toBeLessThanOrEqual(MAX_HEIGHT + 1e-9);
      expect(hs.filter((h) => Math.abs(h - MAX_HEIGHT) < 1e-9).length).toBeGreaterThan(1);
    });

    it('is unaffected by how large the outlier is', () => {
      const small = cargoLike();
      const huge = cargoLike().map((f) =>
        f.path === 'benches/blob.txt' ? { ...f, size: 1e12 } : f,
      );
      const a = cityLayout(small).buildings.filter((b) => b.path !== 'benches/blob.txt');
      const b = cityLayout(huge).buildings.filter((b) => b.path !== 'benches/blob.txt');
      expect(b.map((x) => x.height)).toEqual(a.map((x) => x.height));
    });

    it('clamps height to the maximum and never goes below the minimum', () => {
      const l = cityLayout(cargoLike());
      for (const h of heightsInCells(l)) {
        expect(h).toBeGreaterThanOrEqual(MIN_HEIGHT - 1e-9);
        expect(h).toBeLessThanOrEqual(MAX_HEIGHT + 1e-9);
      }
    });

    it('lets a lone large file among zero-size files reach the maximum height', () => {
      const input = [
        ...Array.from({ length: 99 }, (_, i) => ({ path: `a/z${i}.txt`, size: 0 })),
        { path: 'a/big.txt', size: 5000 },
      ];
      const l = cityLayout(input);
      const big = l.buildings.find((b) => b.path === 'a/big.txt')!;
      expect(big.height / cell(l)).toBeCloseTo(MAX_HEIGHT, 9);
    });

    it('keeps merged "(other)" buildings finite, in range and deterministic', () => {
      const input: F[] = [
        ...Array.from({ length: 200 }, (_, i) => ({
          path: `d${i % 4}/f${i}.ts`,
          size: 1 + ((i * 7919) % 5000),
        })),
        { path: 'd0/outlier.bin', size: 1e12 },
      ];
      const a = cityLayout(input, 50);
      const b = cityLayout(input, 50);
      expect(a.buildings.length).toBeLessThanOrEqual(50);
      expect(a.buildings.length).toBeLessThan(input.length);
      for (const h of heightsInCells(a)) {
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(MIN_HEIGHT - 1e-9);
        expect(h).toBeLessThanOrEqual(MAX_HEIGHT + 1e-9);
      }
      expect(b).toEqual(a);
    });

    it('gives all-zero and single-file cities finite heights', () => {
      const zeros = cityLayout(Array.from({ length: 5 }, (_, i) => ({ path: `a/z${i}`, size: 0 })));
      for (const h of heightsInCells(zeros)) expect(h).toBeCloseTo(MIN_HEIGHT, 9);
      const one = cityLayout([{ path: 'a/only.ts', size: 123 }]);
      expect(one.buildings[0]!.height / cell(one)).toBeCloseTo(MAX_HEIGHT, 9);
    });
  });

  it('gives zero, negative and NaN sizes a finite positive height', () => {
    const l = cityLayout([
      { path: 'a/zero.ts', size: 0 },
      { path: 'a/neg.ts', size: -4 },
      { path: 'a/nan.ts', size: Number.NaN },
      { path: 'a/ok.ts', size: 9 },
    ]);
    expect(l.buildings).toHaveLength(4);
    for (const b of l.buildings) {
      for (const v of [b.x, b.z, b.footprint, b.height]) expect(Number.isFinite(v)).toBe(true);
      expect(b.height).toBeGreaterThan(0);
    }
  });

  it('does not let buildings overlap', () => {
    const bs = cityLayout(bigCity(300)).buildings;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]!;
        const b = bs[j]!;
        const sep = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        expect(sep).toBeGreaterThanOrEqual((a.footprint + b.footprint) / 2 - EPS);
      }
    }
  });

  it('caps 10,000 files at 5,000 buildings including the per-district "other" ones', () => {
    const l = cityLayout(bigCity(10_000));
    expect(l.buildings.length).toBeLessThanOrEqual(5000);
    expect(l.buildings.filter((b) => b.path.endsWith('(other)')).length).toBeGreaterThan(0);
    for (const b of l.buildings) expect(l.districts.some((d) => contains(d, b))).toBe(true);
  });

  it('honours a custom maxBuildings with at most one "other" per district', () => {
    const l = cityLayout(bigCity(600), 300);
    expect(l.buildings.length).toBeLessThanOrEqual(300);
    const others = l.buildings.filter((b) => b.path.endsWith('(other)'));
    expect(others.length).toBeGreaterThan(0);
    expect(new Set(others.map((b) => b.path)).size).toBe(others.length);
  });

  it('keeps one building per district when the cap is below the district count (best effort)', () => {
    const input = bigCity(600);
    const l = cityLayout(input, 10);
    const leaves = new Set(input.map((f) => f.path.split('/').slice(0, 2).join('/')));
    expect(l.buildings).toHaveLength(leaves.size);
    for (const p of leaves) expect(l.districts.map((d) => d.path)).toContain(p);
  });

  it('handles unicode, odd and duplicate paths', () => {
    const input: F[] = [
      { path: '日本語/ファイル/a.ts', size: 3 },
      { path: 'with space/ünï/b.md', size: 3 },
      { path: 'we#ird/?&=/c.txt', size: 3 },
      { path: 'dup.ts', size: 3 },
      { path: 'dup.ts', size: 3 },
    ];
    const l = cityLayout(input);
    expect(l.buildings).toHaveLength(5);
    const have = l.districts.map((d) => d.path);
    for (const p of ['日本語', '日本語/ファイル', 'with space/ünï', 'we#ird/?&='])
      expect(have).toContain(p);
  });

  it('is deterministic and produces only finite numbers', () => {
    const input = bigCity(250);
    const a = cityLayout(input);
    expect(cityLayout(input)).toEqual(a);
    for (const b of a.buildings)
      for (const v of [b.x, b.z, b.footprint, b.height]) expect(Number.isFinite(v)).toBe(true);
    for (const d of a.districts)
      for (const v of [d.x, d.z, d.w, d.d]) expect(Number.isFinite(v)).toBe(true);
  });

  it('lays out 10,000 files well within a generous time bound', () => {
    const input = bigCity(10_000);
    const start = performance.now();
    cityLayout(input);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe('world-unit scale (a narrow district must not collapse the cell)', () => {
  /** One huge folder beside many one-file folders: the squarified leftover is a hair-thin sliver. */
  function cargoLike(): F[] {
    const files: F[] = [];
    for (let i = 0; i < 2800; i++)
      files.push({ path: `tests/testsuite/t${i % 40}/f${i}.rs`, size: 1 + (i % 500) });
    for (let i = 0; i < 300; i++)
      files.push({ path: `src/cargo/mod${i % 12}/f${i}.rs`, size: 100 + i });
    for (const lone of [
      'tests/build-std/a.rs',
      'etc/man/b.txt',
      '.cargo/config.toml',
      'ci/c.sh',
      'credential/d.rs',
    ])
      files.push({ path: lone, size: 50 });
    return files;
  }
  const floorWidth = (l: Layout): number =>
    2 *
    Math.max(
      ...l.districts.map((d) => Math.abs(d.x) + d.w / 2),
      ...l.districts.map((d) => Math.abs(d.z) + d.d / 2),
    );
  const maxFoot = (l: Layout): number => Math.max(...l.buildings.map((b) => b.footprint));
  const minFoot = (l: Layout): number => Math.min(...l.buildings.map((b) => b.footprint));
  const tallest = (l: Layout): number => Math.max(...l.buildings.map((b) => b.height));

  function expectReadableAndSound(l: Layout): void {
    const floor = floorWidth(l);
    const half = floor / 2;
    // Footprint is a sensible fraction of the floor; the skyline reads against it.
    expect(minFoot(l) / floor).toBeGreaterThan(0.003);
    expect(tallest(l) / floor).toBeGreaterThan(0.03);
    expect(minFoot(l)).toBeGreaterThanOrEqual(MIN_CELL * 0.8 - EPS);
    // One shared cell: equal footprints prove no district fell back to a smaller local cell.
    expect(maxFoot(l) - minFoot(l)).toBeLessThanOrEqual(EPS);
    // Nothing leaves the plate, and nothing overlaps.
    for (const b of l.buildings) {
      expect(Math.abs(b.x) + b.footprint / 2).toBeLessThanOrEqual(half + EPS);
      expect(Math.abs(b.z) + b.footprint / 2).toBeLessThanOrEqual(half + EPS);
    }
    const sorted = [...l.buildings].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (b.x - a.x >= (a.footprint + b.footprint) / 2 - EPS) break;
        const apart = Math.abs(a.z - b.z) >= (a.footprint + b.footprint) / 2 - EPS;
        if (!apart) throw new Error(`overlap: ${a.path} / ${b.path}`);
      }
    }
  }

  it('keeps a cargo-like city readable in world units', () => {
    const l = cityLayout(cargoLike());
    expect(maxFoot(l)).toBeGreaterThan(0.5);
    expectReadableAndSound(l);
  });

  it('keeps the real rust-lang/cargo gallery file readable in world units', () => {
    const a = JSON.parse(
      readFileSync(join(process.cwd(), 'public/gallery/rust-lang__cargo.json'), 'utf8'),
    ) as { files: F[] };
    const l = cityLayout(a.files.map((f) => ({ path: f.path, size: f.size })));
    expect(maxFoot(l)).toBeGreaterThan(0.5);
    expectReadableAndSound(l);
  });

  it('never shrinks the shared cell below MIN_CELL for a list with narrow districts', () => {
    const files: F[] = [];
    for (let k = 0; k < 40; k++) files.push({ path: `d${k}/only.ts`, size: 5 });
    for (let i = 0; i < 4000; i++)
      files.push({ path: `big/sub${i % 3}/f${i}.ts`, size: 1 + (i % 50) });
    expectReadableAndSound(cityLayout(files));
  });

  it('does not collapse the cell on a small ordinary repo', () => {
    const l = cityLayout(bigCity(60));
    expect(maxFoot(l)).toBeGreaterThanOrEqual(MIN_CELL * 0.8);
  });
});
