import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { cleanSize, mergeSmallest, type SizedFile } from './treemap';

/** Building `x`/`z` and district `x`/`z` are centres; the whole city is centred on the origin. */
export interface CityBuilding {
  path: string;
  x: number;
  z: number;
  footprint: number;
  height: number;
}

export interface CityDistrict {
  path: string;
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface CityLayout {
  buildings: CityBuilding[];
  districts: CityDistrict[];
}

/** Layout-only pseudo-district for files that sit directly in the root or in a depth-1 folder with subfolders. */
const FILES = '(files)';
/** Internal name of the pseudo-district, which cannot collide with a real folder called "(files)". */
const PSEUDO = '\u0000files';
const display = (path: string): string => path.split(PSEUDO).join(FILES);
const OTHER = '(other)';

/** Fraction of a grid cell a building occupies; the rest is the gap between buildings. */
const FILL = 0.8;
/** Building heights are in grid cells: smallest and tallest. */
export const MIN_HEIGHT = 0.4;
export const MAX_HEIGHT = 10;
/**
 * Sizes at or above this percentile of the cleaned building sizes all reach MAX_HEIGHT, so a
 * single oversized file (a generated or vendored blob) cannot flatten every other building.
 */
const REFERENCE_PERCENTILE = 0.98;
const MAX_SHRINK_STEPS = 200;

interface Placed extends SizedFile {
  district: string;
}

interface DNode {
  path: string;
  /** Buildings held directly (leaf districts only). */
  count: number;
  children: DNode[];
}

function segmentsOf(path: string): string[] {
  return path.split('/');
}

/** Leaf district of each file: its depth-1 or depth-2 folder, or a "(files)" pseudo-district. */
function assignDistricts(files: SizedFile[]): Placed[] {
  const hasSubfolders = new Set<string>();
  for (const f of files) {
    const dirs = segmentsOf(f.path).slice(0, -1);
    if (dirs.length >= 2) hasSubfolders.add(dirs[0]!);
  }
  return files.map((f) => {
    const dirs = segmentsOf(f.path).slice(0, -1);
    let district: string;
    if (dirs.length === 0) district = PSEUDO;
    else if (dirs.length === 1)
      district = hasSubfolders.has(dirs[0]!) ? `${dirs[0]}/${PSEUDO}` : dirs[0]!;
    else district = `${dirs[0]}/${dirs[1]}`;
    return { path: f.path, size: f.size, district };
  });
}

/** The district tree: depth-1 districts, with depth-2 districts and "(files)" nested in them. */
function buildTree(buildings: Placed[]): DNode {
  const counts = new Map<string, number>();
  for (const b of buildings) counts.set(b.district, (counts.get(b.district) ?? 0) + 1);
  const root: DNode = { path: '', count: 0, children: [] };
  const top = new Map<string, DNode>();
  for (const [path, count] of counts) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      const existing = top.get(path);
      if (existing) existing.count += count;
      else {
        const n: DNode = { path, count, children: [] };
        top.set(path, n);
        root.children.push(n);
      }
      continue;
    }
    const parentPath = path.slice(0, slash);
    let parent = top.get(parentPath);
    if (!parent) {
      parent = { path: parentPath, count: 0, children: [] };
      top.set(parentPath, parent);
      root.children.push(parent);
    }
    parent.children.push({ path, count, children: [] });
  }
  return root;
}

/** Nearest-rank percentile of cleaned sizes; falls back to the maximum when that is zero. */
function referenceSize(sizes: number[]): number {
  const sorted = sizes.map(cleanSize).sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(REFERENCE_PERCENTILE * sorted.length) - 1);
  return sorted[rank]! > 0 ? sorted[rank]! : (sorted[sorted.length - 1] ?? 0);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * City layout: districts are the folders at depth 1 and 2 (a depth-2 district nests in its
 * depth-1 parent), laid out as a squarified treemap weighted by building count; every district
 * holds its buildings in a grid of equal footprints, with heights on a square-root scale of
 * size, capped at the 98th percentile of sizes. Past `maxBuildings` the smallest files of each
 * district merge into one "(other)" building, and those count towards the cap (best effort only
 * if there are more leaf districts than the cap).
 */
export function cityLayout(files: SizedFile[], maxBuildings = 5000): CityLayout {
  if (files.length === 0) return { buildings: [], districts: [] };
  const placed = mergeSmallest<Placed>(
    assignDistricts(files),
    maxBuildings,
    (b) => b.district,
    (district, tail) => ({
      path: `${display(district)}/${OTHER}`,
      size: tail.reduce((s, b) => s + cleanSize(b.size), 0),
      district,
    }),
  );
  const total = placed.length;
  const root = buildTree(placed);
  const base = hierarchy<DNode>(root, (n) => (n.children.length > 0 ? n.children : null))
    .sum((n) => n.count)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || compare(a.data.path, b.data.path));

  // The container leaves about 4x the grid area for gaps; shrink the cell until every grid fits.
  const side = 2 * Math.sqrt(total);
  const layout = treemap<DNode>().tile(treemapSquarify).size([side, side]).round(false);
  let cell = 1;
  let tree = layout(base);
  for (let step = 0; ; step++) {
    tree = layout.paddingInner(0.3 * cell).paddingOuter(0.3 * cell)(base);
    const fits = tree.leaves().every((l) => {
      const w = l.x1 - l.x0;
      const h = l.y1 - l.y0;
      const cols = Math.floor(w / cell);
      return cols >= 1 && Math.ceil(l.data.count / cols) * cell <= h;
    });
    if (fits || step >= MAX_SHRINK_STEPS) break;
    cell *= 0.9;
  }

  const half = side / 2;
  const districts: CityDistrict[] = [];
  const grids = new Map<string, { x0: number; y0: number; w: number; h: number }>();
  tree.each((n) => {
    if (n.depth === 0) return;
    const w = n.x1 - n.x0;
    const h = n.y1 - n.y0;
    districts.push({
      path: display(n.data.path),
      x: n.x0 + w / 2 - half,
      z: n.y0 + h / 2 - half,
      w,
      d: h,
    });
    if (n.children === undefined) grids.set(n.data.path, { x0: n.x0, y0: n.y0, w, h });
  });

  const byDistrict = new Map<string, Placed[]>();
  for (const b of placed) {
    const list = byDistrict.get(b.district);
    if (list) list.push(b);
    else byDistrict.set(b.district, [b]);
  }
  const refSize = referenceSize(placed.map((b) => b.size));
  const buildings: CityBuilding[] = [];
  for (const [district, list] of byDistrict) {
    const g = grids.get(district);
    if (!g) continue;
    list.sort((a, b) => cleanSize(b.size) - cleanSize(a.size) || compare(a.path, b.path));
    const cols = Math.max(1, Math.floor(g.w / cell));
    const rows = Math.ceil(list.length / cols);
    const offX = (g.w - Math.min(cols, list.length) * cell) / 2;
    const offY = (g.h - rows * cell) / 2;
    list.forEach((b, i) => {
      const share = refSize > 0 ? Math.min(1, Math.sqrt(cleanSize(b.size) / refSize)) : 0;
      buildings.push({
        path: b.path,
        x: g.x0 + offX + ((i % cols) + 0.5) * cell - half,
        z: g.y0 + offY + (Math.floor(i / cols) + 0.5) * cell - half,
        footprint: cell * FILL,
        height: cell * (MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * share),
      });
    });
  }
  return { buildings, districts };
}
