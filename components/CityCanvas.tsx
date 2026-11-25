'use client';

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { CityLayout } from '@/lib/layout/city';
import type { Arc } from '@/lib/render/arcs';
import { FrameStats, type FrameSummary } from '@/lib/render/frameStats';
import { createCityScene, type CityScene, type SceneHit } from '@/lib/render/scene';
import { Tooltip } from './Tooltip';

export interface CityHit {
  kind: 'building' | 'district';
  path: string;
}

export interface CityCanvasHandle {
  /** Flies the camera to the building for `path` (jumps instead under reduced motion). */
  flyToPath(path: string): void;
  /** Flies the camera to frame the district at `path` (jumps instead under reduced motion). */
  flyToDistrict(path: string): void;
}

export interface CityCanvasProps {
  layout: CityLayout;
  /** One hex colour per `layout.buildings` entry, same order. */
  colours: readonly string[];
  selectedPath?: string | null;
  /** Co-change arcs to draw: the selected file's only, none when nothing is selected. Memoise it. */
  arcs?: readonly Arc[];
  /** Districts to outline (single-owner). */
  badgedDistricts?: ReadonlySet<string>;
  /** District path to tint on the floor (the folder list's hover or choice), or none. */
  highlightedDistrict?: string | null;
  /** `null` when empty ground is clicked. */
  onSelect?: (hit: CityHit | null) => void;
  /** Text for the hover tooltip; return null for none. Defaults to the path. Rendered as text, cut to 200 characters. */
  tooltipText?: (hit: CityHit) => string | null;
  /** Called if the WebGL scene cannot be created, so the parent can fall back to the 2D view. */
  onError?: (error: unknown) => void;
  /** Dev-only frame counter; ignored outside `next dev`. */
  showFrameStats?: boolean;
  /** Slowly orbits (ignored under reduced motion). */
  autoRotate?: boolean;
  ref?: Ref<CityCanvasHandle>;
}

const DEV = process.env.NODE_ENV === 'development';

/** The 3D city. Fills its container; give the parent a size. */
export function CityCanvas({
  layout,
  colours,
  selectedPath = null,
  arcs,
  badgedDistricts,
  highlightedDistrict = null,
  onSelect,
  tooltipText,
  onError,
  showFrameStats = false,
  autoRotate = false,
  ref,
}: CityCanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CityScene | null>(null);
  const stats = useRef(new FrameStats());
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [summary, setSummary] = useState<FrameSummary | null>(null);
  const counting = DEV && showFrameStats;

  // Latest props for the scene's long-lived callbacks.
  const latest = useRef({ layout, colours, onSelect, tooltipText, onError });
  useEffect(() => {
    latest.current = { layout, colours, onSelect, tooltipText, onError };
  });

  const indexByPath = useMemo(
    () => new Map(layout.buildings.map((b, i) => [b.path, i] as const)),
    [layout],
  );

  useImperativeHandle(
    ref,
    () => ({
      flyToPath(path) {
        const i = indexByPath.get(path);
        if (i !== undefined) sceneRef.current?.flyTo(i);
      },
      flyToDistrict(path) {
        sceneRef.current?.flyToDistrict(path);
      },
    }),
    [indexByPath],
  );

  useEffect(() => {
    const el = canvas.current;
    const holder = box.current;
    if (!el || !holder) return;
    const toHit = (h: SceneHit): CityHit | null => {
      const l = latest.current.layout;
      const path = h.kind === 'building' ? l.buildings[h.index]?.path : l.districts[h.index]?.path;
      return path === undefined ? null : { kind: h.kind, path };
    };
    let scene: CityScene;
    try {
      scene = createCityScene(el, {
        onHover(h, position) {
          const hit = h ? toHit(h) : null;
          if (!hit) return setTip(null);
          const text = (latest.current.tooltipText ?? ((x: CityHit) => x.path))(hit);
          setTip(text === null ? null : { text, ...position });
        },
        onSelect(h) {
          latest.current.onSelect?.(h ? toHit(h) : null);
        },
        onFrame: (ms) => stats.current.push(ms),
        labelRoot: labels.current ?? undefined,
      });
    } catch (error) {
      latest.current.onError?.(error);
      return;
    }
    sceneRef.current = scene;
    const fit = () => scene.setSize(holder.clientWidth, holder.clientHeight);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(holder);
    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setLayout(layout, latest.current.colours);
  }, [layout]);

  useEffect(() => {
    sceneRef.current?.setColours(colours);
  }, [colours, layout]);

  useEffect(() => {
    sceneRef.current?.setBadgedDistricts(badgedDistricts ?? new Set());
  }, [badgedDistricts, layout]);

  useEffect(() => {
    sceneRef.current?.setHighlightedDistrict(highlightedDistrict);
  }, [highlightedDistrict, layout]);

  useEffect(() => {
    sceneRef.current?.setArcs(arcs ?? []);
  }, [arcs, layout]);

  useEffect(() => {
    const i = selectedPath === null ? undefined : indexByPath.get(selectedPath);
    sceneRef.current?.setSelected(i ?? null);
  }, [selectedPath, indexByPath]);

  useEffect(() => {
    const scene = sceneRef.current;
    scene?.setContinuous(counting);
    scene?.setAutoRotate(autoRotate);
    if (!counting) return;
    stats.current.reset();
    const id = setInterval(() => setSummary(stats.current.summary()), 500);
    return () => clearInterval(id);
  }, [counting, autoRotate]);

  return (
    <div
      ref={box}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    >
      <canvas
        ref={canvas}
        aria-label="3D city of the repository's files"
        style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }}
      />
      <div
        ref={labels}
        style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
      />
      {tip ? <Tooltip text={tip.text} x={tip.x} y={tip.y} /> : null}
      {counting && summary ? (
        <div
          style={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            padding: '4px 8px',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            font: '12px var(--font-mono, ui-monospace, monospace)',
          }}
        >
          {summary.fps.toFixed(1)} fps · mean {summary.meanMs.toFixed(1)} ms · p99{' '}
          {summary.p99Ms.toFixed(1)} ms · worst {summary.worstMs.toFixed(1)} ms · {summary.frames}{' '}
          frames
        </div>
      ) : null}
    </div>
  );
}
