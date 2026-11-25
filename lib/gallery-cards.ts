import { z } from 'zod';
import type { Analysis } from '@/lib/analysis/types';
import { treemap2D } from '@/lib/layout/treemap';
import { COLD, buildColourContext, colourFor } from '@/lib/render/colours';
import { formatDay } from '@/lib/viewer/model';

export const THUMB_W = 240;
export const THUMB_H = 150;
/** Few rectangles are enough for a thumbnail and keep the home page's HTML small. */
export const THUMB_MAX_RECTS = 300;

export interface ThumbRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

export interface GalleryCard {
  owner: string;
  name: string;
  /** The language with the most bytes, or null when every file is "Other". */
  language: string | null;
  /** `yyyy-mm-dd`: the end of the analysed window for a curated card, the (UTC) analysis day for a live one. */
  analysedOn: string;
  /** True for a repo a visitor analysed live; false for a curated gallery repo. */
  live: boolean;
  rects: ThumbRect[];
}

const CardSchema = z.object({
  owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  language: z.string().max(100).nullable(),
  analysedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  live: z.boolean(),
  rects: z
    .array(
      z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        w: z.number().finite(),
        h: z.number().finite(),
        fill: z.string().regex(/^#[0-9a-f]{6}$/i),
      }),
    )
    .max(THUMB_MAX_RECTS),
});

/** A stored card back from the database, or null when it is malformed (a bad row is skipped, never rendered). */
export function parseCard(value: unknown): GalleryCard | null {
  const r = CardSchema.safeParse(value);
  return r.success ? r.data : null;
}

function dominantLanguage(analysis: Analysis): string | null {
  const bytes = new Map<string, number>();
  for (const f of analysis.files) {
    if (f.language === 'Other') continue;
    bytes.set(f.language, (bytes.get(f.language) ?? 0) + f.size);
  }
  let best: string | null = null;
  let bestBytes = -1;
  for (const [language, size] of bytes) {
    if (size > bestBytes || (size === bestBytes && best !== null && language < best)) {
      best = language;
      bestBytes = size;
    }
  }
  return best;
}

/** What the home page needs from one stored analysis (pass `analysedAt` for a live one): a summary and a hotspot-coloured treemap thumbnail. */
export function galleryCard(analysis: Analysis, analysedAt?: Date): GalleryCard {
  const ctx = buildColourContext(analysis.files, analysis.window.to);
  const byPath = new Map(analysis.files.map((f) => [f.path, f] as const));
  const rects = treemap2D(analysis.files, THUMB_W, THUMB_H, THUMB_MAX_RECTS).map((r) => {
    const file = byPath.get(r.path);
    return {
      x: round(r.x),
      y: round(r.y),
      w: round(r.w),
      h: round(r.h),
      fill: file ? colourFor('hotspot', file, ctx) : COLD,
    };
  });
  return {
    owner: analysis.repo.owner,
    name: analysis.repo.name,
    language: dominantLanguage(analysis),
    analysedOn: analysedAt ? analysedAt.toISOString().slice(0, 10) : formatDay(analysis.window.to),
    live: analysedAt !== undefined,
    rects,
  };
}

const round = (n: number): number => Math.round(n * 10) / 10;
