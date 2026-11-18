import type { FileStat } from '@/lib/analysis/types';
import type { CityLayout } from '@/lib/layout/city';

export type Vec3 = readonly [number, number, number];

/** One co-change link from the selected file to a partner, in city coordinates (rooftop to rooftop). */
export interface Arc {
  /** The partner's path (repo-derived: only ever used as a key or a text node). */
  path: string;
  from: Vec3;
  to: Vec3;
  /** The height of the curve at its middle (its peak, give or take, when the two rooftops differ). */
  apex: number;
  /** Co-change score, 0 to 1. */
  score: number;
}

/**
 * Arcs for the selected file only: one per `coChange` partner that has its own building. A partner
 * folded into an "(other)" block, or missing from the layout, has no arc. No file, no arcs.
 */
export function arcsFor(file: FileStat | null | undefined, layout: CityLayout): Arc[] {
  if (!file) return [];
  const byPath = new Map(layout.buildings.map((b) => [b.path, b] as const));
  const source = byPath.get(file.path);
  if (!source) return [];
  const seen = new Set<string>([file.path]);
  const arcs: Arc[] = [];
  for (const partner of file.coChange) {
    if (seen.has(partner.path)) continue;
    seen.add(partner.path);
    const target = byPath.get(partner.path);
    if (!target) continue;
    const dist = Math.hypot(target.x - source.x, target.z - source.z);
    arcs.push({
      path: partner.path,
      from: [source.x, source.height, source.z],
      to: [target.x, target.height, target.z],
      apex: Math.max(source.height, target.height) + 1 + dist * 0.25,
      score: partner.score,
    });
  }
  return arcs;
}

/** Points along the arc (a quadratic curve whose peak is `apex`), `steps + 1` of them, flattened x y z. */
export function arcPoints(arc: Arc, steps = 24): number[] {
  const [x0, y0, z0] = arc.from;
  const [x2, y2, z2] = arc.to;
  // For a quadratic Bezier the peak is (y0 + 2c + y2) / 4, so c puts it at `apex`.
  const cy = (4 * arc.apex - y0 - y2) / 2;
  const cx = (x0 + x2) / 2;
  const cz = (z0 + z2) / 2;
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    out.push(a * x0 + b * cx + c * x2, a * y0 + b * cy + c * y2, a * z0 + b * cz + c * z2);
  }
  return out;
}

/** The same curve as line-segment vertex pairs (what `LineSegments` draws). */
export function arcSegments(arc: Arc, steps = 24): number[] {
  const p = arcPoints(arc, steps);
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(...p.slice(i * 3, i * 3 + 6));
  return out;
}
