import type { CityBuilding, CityDistrict, CityLayout } from '@/lib/layout/city';

/** Thickness of a depth-1 and a depth-2 district plate; both tops sit at or below ground level. */
const PLATE_DEPTH1 = { top: -0.02, thickness: 0.3 };
const PLATE_DEPTH2 = { top: 0, thickness: 0.15 };

/** Column-major 4x4 matrix for a translation plus a non-uniform scale (no rotation). */
function writeTrs(
  out: Float32Array,
  i: number,
  px: number,
  py: number,
  pz: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const o = i * 16;
  out[o] = sx;
  out[o + 5] = sy;
  out[o + 10] = sz;
  out[o + 12] = px;
  out[o + 13] = py;
  out[o + 14] = pz;
  out[o + 15] = 1;
}

/** One matrix per building, for a unit box whose base sits at y = 0 (the geometry is shifted up). */
export function buildingMatrices(buildings: readonly CityBuilding[]): Float32Array {
  const out = new Float32Array(buildings.length * 16);
  buildings.forEach((b, i) => writeTrs(out, i, b.x, 0, b.z, b.footprint, b.height, b.footprint));
  return out;
}

/** District depth: 1 for "src", 2 for "src/lib" and "src/(files)". */
export function districtDepth(path: string): 1 | 2 {
  return path.includes('/') ? 2 : 1;
}

/** One matrix per district plate, for a unit box centred on its own origin. */
export function plateMatrices(districts: readonly CityDistrict[]): Float32Array {
  const out = new Float32Array(districts.length * 16);
  districts.forEach((d, i) => {
    const p = districtDepth(d.path) === 1 ? PLATE_DEPTH1 : PLATE_DEPTH2;
    writeTrs(out, i, d.x, p.top - p.thickness / 2, d.z, d.w, p.thickness, d.d);
  });
  return out;
}

/** Half the longest side of the city's footprint, used to frame the camera. At least 1. */
export function cityRadius(layout: CityLayout): number {
  let r = 0;
  for (const d of layout.districts) {
    r = Math.max(r, Math.abs(d.x) + d.w / 2, Math.abs(d.z) + d.d / 2);
  }
  for (const b of layout.buildings) {
    r = Math.max(r, Math.abs(b.x) + b.footprint / 2, Math.abs(b.z) + b.footprint / 2);
  }
  return Math.max(1, r);
}
