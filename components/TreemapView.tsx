'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { treemap2D, type SizedFile } from '@/lib/layout/treemap';
import { TOKENS } from '@/lib/render/colours';
import { districtBounds, hitRect } from '@/lib/render/treemapDraw';
import { Tooltip } from './Tooltip';

export interface TreemapViewProps {
  files: readonly SizedFile[];
  /** Hex colour for a rectangle's path (an "(other)" merge rectangle has no file; return the grey). */
  colourOf: (path: string) => string;
  selectedPath?: string | null;
  /** Districts to outline (single-owner). */
  badgedDistricts?: ReadonlySet<string>;
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
  onSelect,
  tooltipText,
}: TreemapViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
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
    const sel = selectedPath === null ? undefined : rects.find((r) => r.path === selectedPath);
    if (sel) {
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(sel.x + 1, sel.y + 1, Math.max(0, sel.w - 2), Math.max(0, sel.h - 2));
    }
  }, [rects, bounds, colourOf, selectedPath, size]);

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
