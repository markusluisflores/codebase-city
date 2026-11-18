'use client';

import { useMemo, useState } from 'react';
import { CityCanvas } from '@/components/CityCanvas';
import { TreemapView } from '@/components/TreemapView';
import { cityLayout } from '@/lib/layout/city';
import {
  COLOUR_MODES,
  buildColourContext,
  colourFor,
  COLD,
  type ColourMode,
} from '@/lib/render/colours';
import { syntheticFiles } from '@/lib/render/fixture';

const NOW = 1_800_000_000;

export function FramesClient() {
  const files = useMemo(() => syntheticFiles(5000, NOW), []);
  const layout = useMemo(
    () => cityLayout(files.map((f) => ({ path: f.path, size: f.size }))),
    [files],
  );
  const ctx = useMemo(() => buildColourContext(files, NOW), [files]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const [mode, setMode] = useState<ColourMode>('hotspot');
  const [view, setView] = useState<'3d' | '2d'>('3d');
  const [spin, setSpin] = useState(true);

  const colourOf = useMemo(
    () => (path: string) => {
      const f = byPath.get(path);
      return f ? colourFor(mode, f, ctx) : COLD;
    },
    [byPath, ctx, mode],
  );
  const colours = useMemo(() => layout.buildings.map((b) => colourOf(b.path)), [layout, colourOf]);
  const treemapFiles = useMemo(() => files.map((f) => ({ path: f.path, size: f.size })), [files]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div
        style={{ display: 'flex', gap: 12, padding: 8, borderBottom: '1px solid var(--border)' }}
      >
        <strong>Frame-time check (dev only)</strong>
        <span style={{ color: 'var(--muted)' }}>{layout.buildings.length} buildings</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ColourMode)}
          aria-label="Colour mode"
        >
          {COLOUR_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setView(view === '3d' ? '2d' : '3d')}>
          {view === '3d' ? 'Show 2D' : 'Show 3D'}
        </button>
        <label>
          <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} />{' '}
          auto-orbit
        </label>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === '3d' ? (
          <CityCanvas layout={layout} colours={colours} showFrameStats autoRotate={spin} />
        ) : (
          <TreemapView files={treemapFiles} colourOf={colourOf} />
        )}
      </div>
    </div>
  );
}
