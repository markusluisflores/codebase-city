import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';

export interface SizedFile {
  path: string;
  size: number;
}

export interface Rect {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest share of the total a file may take, so zero-size files keep a visible area. */
const MIN_SHARE = 1e-6;

/** Sizes that are not finite or not positive count as zero. */
export function cleanSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Keeps the largest items and merges the rest into one item per group, so the result has at most
 * `max` items. Groups whose tail holds a single item keep that item unmerged. When there are more
 * groups than `max`, every group still gets one item, so the cap is best effort in that case.
 */
export function mergeSmallest<T extends { size: number }>(
  items: T[],
  max: number,
  groupOf: (item: T) => string,
  merge: (group: string, tail: T[]) => T,
): T[] {
  const cap = Math.max(1, Math.floor(max));
  if (items.length <= cap) return items.slice();
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => cleanSize(b.item.size) - cleanSize(a.item.size) || a.index - b.index)
    .map((e) => e.item);
  const tailGroups = (keep: number): number => {
    const seen = new Set<string>();
    for (let i = keep; i < order.length; i++) seen.add(groupOf(order[i]!));
    return seen.size;
  };
  // keep + tailGroups(keep) never decreases as keep grows, so binary search the largest fit.
  let lo = 0;
  let hi = cap;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (mid + tailGroups(mid) <= cap) lo = mid;
    else hi = mid - 1;
  }
  const kept = order.slice(0, lo);
  const byGroup = new Map<string, T[]>();
  for (let i = lo; i < order.length; i++) {
    const item = order[i]!;
    const g = groupOf(item);
    const list = byGroup.get(g);
    if (list) list.push(item);
    else byGroup.set(g, [item]);
  }
  for (const [group, tail] of byGroup) kept.push(tail.length === 1 ? tail[0]! : merge(group, tail));
  return kept;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

interface Node {
  name: string;
  path: string;
  value: number;
  children: Node[];
  folders: Map<string, Node>;
}

function node(name: string): Node {
  return { name, path: '', value: 0, children: [], folders: new Map() };
}

/**
 * Squarified 2D treemap of the files nested by folder. Rectangles are `{x, y}` top-left in a
 * `width` by `height` container and their areas fill it exactly, in proportion to size. With more
 * than `maxRects` files the smallest are merged into one `<folder>/(other)` rectangle per folder.
 */
export function treemap2D(
  files: SizedFile[],
  width: number,
  height: number,
  maxRects = 5000,
): Rect[] {
  if (files.length === 0 || !(width > 0) || !(height > 0)) return [];
  const merged = mergeSmallest<SizedFile>(
    files,
    maxRects,
    (f) => dirOf(f.path),
    (dir, tail) => ({
      path: dir === '' ? '(other)' : `${dir}/(other)`,
      size: tail.reduce((s, f) => s + cleanSize(f.size), 0),
    }),
  );
  const total = merged.reduce((s, f) => s + cleanSize(f.size), 0);
  const floor = total > 0 ? total * MIN_SHARE : 1;
  const root = node('');
  for (const f of merged) {
    let cur = root;
    const segments = f.path.split('/');
    for (const seg of segments.slice(0, -1)) {
      let next = cur.folders.get(seg);
      if (!next) {
        next = node(seg);
        cur.folders.set(seg, next);
        cur.children.push(next);
      }
      cur = next;
    }
    const leaf = node(segments[segments.length - 1] ?? '');
    leaf.path = f.path;
    leaf.value = Math.max(cleanSize(f.size), floor);
    cur.children.push(leaf);
  }
  const tree = hierarchy<Node>(root, (n) => (n.children.length > 0 ? n.children : null))
    .sum((n) => (n.children.length === 0 ? n.value : 0))
    .sort(
      (a, b) =>
        (b.value ?? 0) - (a.value ?? 0) ||
        (a.data.name < b.data.name ? -1 : a.data.name > b.data.name ? 1 : 0),
    );
  const laid = treemap<Node>().tile(treemapSquarify).size([width, height]).round(false)(tree);
  return laid.leaves().map((l) => ({
    path: l.data.path,
    x: l.x0,
    y: l.y0,
    w: l.x1 - l.x0,
    h: l.y1 - l.y0,
  }));
}
