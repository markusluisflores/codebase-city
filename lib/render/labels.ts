/** Most labels shown at once, in either view. */
export const MAX_LABELS = 12;

/** Narrowest district, in pixels, that gets a label; narrower ones stay anonymous. */
export const MIN_LABEL_WIDTH = 60;
export const MIN_LABEL_HEIGHT = 16;

const FILES = '(files)';
const MIN_CHARS = 6;

/** A district's rectangle on screen, in canvas pixels. */
export interface LabelCandidate {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLabel {
  path: string;
  text: string;
  /** Anchor point in canvas pixels: the text's centre, or its top-left corner. */
  x: number;
  y: number;
  opacity: number;
}

export interface ChooseOptions {
  minWidth?: number;
  minHeight?: number;
  /** Estimated pixel width of one character of the label font. */
  charWidth: number;
  lineHeight: number;
  anchor: 'centre' | 'topleft';
}

/** Text that fits `widthPx`: the full path, else its last folder name, else that name cut with an ellipsis. */
export function fitLabel(path: string, widthPx: number, charWidth: number): string | null {
  const chars = Math.floor(widthPx / charWidth);
  if (path.length <= chars) return path;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.length <= chars) return name;
  if (chars < MIN_CHARS) return null;
  return `${name.slice(0, chars - 1)}…`;
}

const isPseudo = (path: string): boolean => path === FILES || path.endsWith(`/${FILES}`);

/** Whether a district gets a label: a leaf folder (no district below it), never a "(files)" pseudo-district. */
export function isLabelDistrict(path: string, all: readonly string[]): boolean {
  if (isPseudo(path)) return false;
  const prefix = `${path}/`;
  return !all.some((p) => p.startsWith(prefix) && !isPseudo(p));
}

/** 0 at the minimum width, 1 from 1.6 times it: labels fade in as the viewer zooms in. */
export function labelOpacity(widthPx: number, minWidth: number): number {
  return Math.min(1, Math.max(0, (widthPx - minWidth) / (minWidth * 0.6)));
}

/** Files under each district path (a file counts for its depth-1 and depth-2 folder). */
export function districtFileCounts(
  districts: readonly string[],
  files: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>(districts.map((d) => [d, 0]));
  for (const f of files) {
    const parts = f.split('/');
    for (let depth = 1; depth <= Math.min(2, parts.length - 1); depth++) {
      const folder = parts.slice(0, depth).join('/');
      const n = counts.get(folder);
      if (n !== undefined) counts.set(folder, n + 1);
    }
  }
  return counts;
}

/**
 * Picks the labels to draw: the biggest districts first, skipping those under the pixel threshold or
 * whose text would overlap one already chosen, at most MAX_LABELS. Pure; the caller draws the result.
 */
export function chooseLabels(
  candidates: readonly LabelCandidate[],
  opts: ChooseOptions,
): PlacedLabel[] {
  const minW = opts.minWidth ?? MIN_LABEL_WIDTH;
  const minH = opts.minHeight ?? MIN_LABEL_HEIGHT;
  const order = candidates
    .filter((c) => c.w >= minW && c.h >= minH)
    .sort((a, b) => b.w * b.h - a.w * a.h || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const placed: PlacedLabel[] = [];
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const pad = 4;
  for (const c of order) {
    if (placed.length >= MAX_LABELS) break;
    const text = fitLabel(c.path, c.w - 2 * pad, opts.charWidth);
    if (text === null) continue;
    const tw = text.length * opts.charWidth;
    const x = opts.anchor === 'centre' ? c.x + c.w / 2 : c.x + pad;
    const y = opts.anchor === 'centre' ? c.y + c.h / 2 : c.y + pad;
    const x0 = opts.anchor === 'centre' ? x - tw / 2 : x;
    const y0 = opts.anchor === 'centre' ? y - opts.lineHeight / 2 : y;
    const box = { x0: x0 - 2, y0: y0 - 1, x1: x0 + tw + 2, y1: y0 + opts.lineHeight + 1 };
    if (boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0))
      continue;
    boxes.push(box);
    placed.push({ path: c.path, text, x, y, opacity: labelOpacity(c.w, minW) });
  }
  return placed;
}

/**
 * Screen rectangle of a district's floor corners, given each corner in normalised device
 * coordinates (-1 to 1, y up) and whether it is behind the camera. Returns null when any corner is
 * behind the camera (it would mis-project) or the rectangle is wholly off screen; otherwise the
 * rectangle is clamped to the viewport so a district larger than the screen is labelled where it shows.
 */
export function screenRect(
  corners: readonly { x: number; y: number; behind: boolean }[],
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    if (c.behind) return null;
    const px = ((c.x + 1) / 2) * width;
    const py = ((1 - c.y) / 2) * height;
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(width, x1);
  y1 = Math.min(height, y1);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
