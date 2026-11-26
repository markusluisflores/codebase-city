'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { treemap2D, type SizedFile } from '@/lib/layout/treemap';
import { TOKENS } from '@/lib/render/colours';
import {
  MIN_LABEL_HEIGHT,
  MIN_LABEL_WIDTH,
  chooseLabels,
  isLabelDistrict,
} from '@/lib/render/labels';
import { districtBounds, hitRect } from '@/lib/render/treemapDraw';

// Same face and size as the 3D labels; 11px Fira Code is about 6.6px wide per character.
const LABEL_CHAR_PX = 7;
const LABEL_LINE_PX = 14;
import { Tooltip } from './Tooltip';

export interface TreemapViewProps {
  files: readonly SizedFile[];
  /** Hex colour for a rectangle's path (an "(other)" merge rectangle has no file; return the grey). */
  colourOf: (path: string) => string;
  selectedPath?: string | null;
  /** Districts to outline (single-owner). */
  badgedDistricts?: ReadonlySet<string>;
  /** Every district path (depth-1 and depth-2 folders); the larger ones are named inside their rectangles. */
  districtPaths?: readonly string[];
  /** District path to tint (the folder list's hover or choice), or none. */
  highlightedDistrict?: string | null;
  /** `null` when empty space is clicked. */
  onSelect?: (path: string | null) => void;
  /** Hover text; return null for none. Defaults to the path. Rendered as text, cut to 200 characters. */
  tooltipText?: (path: string) => string | null;
}

/** The 2D treemap on a canvas, at most 5,000 rectangles. Fills its container; give the parent a size. */
export function TreemapView({
  files,
  colourOf,
  selectedPath = null,
  badgedDistricts,
  districtPaths,
  highlightedDistrict = null,
  onSelect,
  tooltipText,
}: TreemapViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Redraw once the page fonts have loaded, so the labels do not stay in the fallback face.
  const [fontsLoaded, setFontsLoaded] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) setFontsLoaded((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const holder = box.current;
    if (!holder) return;
    const fit = () => setSize({ w: holder.clientWidth, h: holder.clientHeight });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  const rects = useMemo(() => treemap2D([...files], size.w, size.h), [files, size]);
  const bounds = useMemo(
    () => districtBounds(rects, badgedDistricts ?? new Set()),
    [rects, badgedDistricts],
  );

  // Rectangles of every district, computed once per layout; hover only looks one up.
  const districtBoxes = useMemo(
    () => districtBounds(rects, new Set(districtPaths ?? [])),
    [rects, districtPaths],
  );
  const labels = useMemo(() => {
    const all = districtPaths ?? [];
    const known = new Set(all);
    const candidates = districtBoxes
      .filter((b) => known.has(b.path) && isLabelDistrict(b.path, all))
      .map((b) => ({ path: b.path, x: b.x, y: b.y, w: b.w, h: b.h }));
    return chooseLabels(candidates, {
      minWidth: MIN_LABEL_WIDTH,
      minHeight: MIN_LABEL_HEIGHT,
      charWidth: LABEL_CHAR_PX,
      lineHeight: LABEL_LINE_PX,
      anchor: 'topleft',
    });
  }, [districtBoxes, districtPaths]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || size.w === 0 || size.h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.floor(size.w * dpr);
    el.height = Math.floor(size.h * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = TOKENS.bg;
    ctx.fillRect(0, 0, size.w, size.h);
    for (const r of rects) {
      ctx.fillStyle = colourOf(r.path);
      ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = TOKENS.accent;
    for (const b of bounds)
      ctx.strokeRect(b.x + 1, b.y + 1, Math.max(0, b.w - 2), Math.max(0, b.h - 2));
    const hl =
      highlightedDistrict === null
        ? undefined
        : districtBoxes.find((b) => b.path === highlightedDistrict);
    if (hl) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = TOKENS.accent;
      ctx.fillRect(hl.x, hl.y, hl.w, hl.h);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = TOKENS.text;
      ctx.strokeRect(hl.x + 1, hl.y + 1, Math.max(0, hl.w - 2), Math.max(0, hl.h - 2));
    }
    // Canvas cannot resolve var(--font-mono), so read the family from the page.
    const family = getComputedStyle(el).getPropertyValue('--font-mono').trim();
    ctx.font = `500 11px ${family ? `${family}, ` : ''}ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    for (const l of labels) {
      ctx.globalAlpha = l.opacity;
      ctx.strokeStyle = TOKENS.bg;
      ctx.strokeText(l.text, l.x, l.y);
      ctx.fillStyle = TOKENS.text;
      ctx.fillText(l.text, l.x, l.y);
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    const sel = selectedPath === null ? undefined : rects.find((r) => r.path === selectedPath);
    if (sel) {
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(sel.x + 1, sel.y + 1, Math.max(0, sel.w - 2), Math.max(0, sel.h - 2));
    }
  }, [
    rects,
    bounds,
    colourOf,
    selectedPath,
    size,
    districtBoxes,
    labels,
    highlightedDistrict,
    fontsLoaded,
  ]);

  const at = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, hit: hitRect(rects, x, y) };
  };

  return (
    <div
      ref={box}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    >
      <canvas
        ref={canvas}
        aria-label="2D treemap of the repository's files"
        style={{ display: 'block', width: '100%', height: '100%' }}
        onPointerMove={(e) => {
          const p = at(e);
          const text = p?.hit ? (tooltipText ?? ((x: string) => x))(p.hit.path) : null;
          setTip(p && text !== null ? { text, x: p.x, y: p.y } : null);
        }}
        onPointerLeave={() => setTip(null)}
        onClick={(e) => onSelect?.(at(e)?.hit?.path ?? null)}
      />
      {tip ? <Tooltip text={tip.text} x={tip.x} y={tip.y} /> : null}
    </div>
  );
}
