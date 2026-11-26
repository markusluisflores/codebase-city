'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canUseWebGL } from '@/lib/a11y';
import type { Analysis } from '@/lib/analysis/types';
import { cityLayout } from '@/lib/layout/city';
import { arcsFor } from '@/lib/render/arcs';
import {
  COLD,
  COLOUR_MODES,
  buildColourContext,
  colourFor,
  type ColourMode,
} from '@/lib/render/colours';
import { districtBadges } from '@/lib/render/legend';
import { districtTooltip, formatDay, shortSha, treemapTooltip } from '@/lib/viewer/model';
import { CityCanvas, type CityCanvasHandle, type CityHit } from './CityCanvas';
import { districtFileCounts } from '@/lib/render/labels';
import { DetailsPanel } from './DetailsPanel';
import { FolderList } from './FolderList';
import { Legend } from './Legend';
import { ReanalyseStrip } from './ReanalyseStrip';
import { ReportCard } from './ReportCard';
import { SearchBox } from './SearchBox';
import { ThinHistoryNote } from './ThinHistoryNote';
import { TreemapView } from './TreemapView';
import s from './viewer.module.css';
import st from './states.module.css';

export interface ViewerProps {
  analysis: Analysis;
  source: 'gallery' | 'live';
  /** ISO timestamp of the stored row; null for a gallery analysis (the window end is shown instead). */
  analysedAt: string | null;
  /**
   * Turns on "Check for new commits" for unlocked visitors on a live analysis. `onDone` reloads the data
   * when a re-analysis finishes; `stale` says the reload still returned the previous analysis.
   */
  reanalyse?: { onDone: () => void; stale: boolean; onReload: () => void };
}

const MODE_LABEL: Record<ColourMode, string> = {
  hotspot: 'Hotspot',
  churn: 'Churn',
  age: 'Age',
  bugfix: 'Bug-fix density',
  language: 'Language',
  ownership: 'Ownership',
};

type View = '3d' | '2d';

/** The viewer for one stored analysis: top bar, report card, canvas with legend and picker, details. */
export function Viewer({ analysis, source, analysedAt, reanalyse }: ViewerProps) {
  const { repo, window: win, files, districts, report, stats } = analysis;
  const [mode, setMode] = useState<ColourMode>('hotspot');
  const [view, setView] = useState<View>('3d');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Folder list: `previewFolder` follows hover or focus, `chosenFolder` is the last click.
  const [previewFolder, setPreviewFolder] = useState<string | null>(null);
  const [chosenFolder, setChosenFolder] = useState<string | null>(null);
  // Checked once, up front: the viewer only renders in the browser (after the analysis loads).
  const [noWebGL, setNoWebGL] = useState(() => !canUseWebGL());
  const city = useRef<CityCanvasHandle>(null);
  const main = useRef<HTMLElement>(null);
  const sheetButton = useRef<HTMLButtonElement>(null);

  // A route change lands on the main region, so keyboard and screen-reader users start in the content.
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
  }, []);

  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f] as const)), [files]);
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const ctx = useMemo(() => buildColourContext(files, win.to), [files, win.to]);
  const layout = useMemo(() => cityLayout(files), [files]);
  const badges = useMemo(() => districtBadges(districts), [districts]);
  const badgeByPath = useMemo(() => new Map(badges.map((b) => [b.path, b] as const)), [badges]);
  const badged = useMemo<ReadonlySet<string>>(() => new Set(badges.map((b) => b.path)), [badges]);

  const districtPaths = useMemo(() => districts.map((d) => d.path), [districts]);
  const folders = useMemo(() => {
    const counts = districtFileCounts(districtPaths, paths);
    return districtPaths.map((path) => ({ path, files: counts.get(path) ?? 0 }));
  }, [districtPaths, paths]);
  const highlightedFolder = previewFolder ?? chosenFolder;

  const chooseFolder = useCallback(
    (path: string) => {
      // A tap fires hover and focus first and nothing clears them: drop the preview so the tint follows the choice.
      setPreviewFolder(null);
      if (chosenFolder === path) {
        setChosenFolder(null);
        return;
      }
      setChosenFolder(path);
      // On phones the sheet would cover the district the camera flies to; focus follows it out.
      if (sheetOpen) {
        setSheetOpen(false);
        sheetButton.current?.focus();
      }
      if (view === '3d' && !noWebGL) city.current?.flyToDistrict(path);
    },
    [chosenFolder, view, noWebGL, sheetOpen],
  );

  const colourOf = useCallback(
    (path: string) => {
      const f = byPath.get(path);
      return f ? colourFor(mode, f, ctx) : COLD;
    },
    [byPath, mode, ctx],
  );
  // Escape closes the phone sheet wherever focus is (after a tap on the canvas it stays on <main>)
  // and hands focus back to the button that opens it.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setSheetOpen(false);
      sheetButton.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const selectedFile = selectedPath === null ? null : (byPath.get(selectedPath) ?? null);
  // Arcs for the selected file only; none when nothing is selected.
  const arcs = useMemo(() => arcsFor(selectedFile, layout), [selectedFile, layout]);
  const colours = useMemo(() => layout.buildings.map((b) => colourOf(b.path)), [layout, colourOf]);

  const select = useCallback((path: string) => {
    setSelectedPath(path);
    setSheetOpen(true); // On phones the details live in the sheet; show them.
    city.current?.flyToPath(path);
  }, []);

  const onCitySelect = useCallback((hit: CityHit | null) => {
    if (hit === null) setSelectedPath(null);
    else if (hit.kind === 'building') {
      setSelectedPath(hit.path);
      setSheetOpen(true);
    }
  }, []);

  const cityTooltip = useCallback(
    (hit: CityHit) => {
      if (hit.kind === 'district') {
        const badge = badgeByPath.get(hit.path);
        return badge ? districtTooltip(badge) : hit.path;
      }
      return hit.path;
    },
    [badgeByPath],
  );

  const treemapText = useCallback(
    (path: string) => treemapTooltip(path, badgeByPath),
    [badgeByPath],
  );

  const day = analysedAt ? analysedAt.slice(0, 10) : formatDay(win.to);
  const effectiveView: View = noWebGL ? '2d' : view;

  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <Link href="/" className={s.brand}>
          Codebase City
        </Link>
        <h1 className={s.repo}>{`${repo.owner}/${repo.name}`}</h1>
        <span className={s.analysed}>{`analysed on ${day} at ${shortSha(repo.headSha)}`}</span>
        <span className={s.spacer} />
        <div className={s.toggle} role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={effectiveView === '3d'}
            disabled={noWebGL}
            onClick={() => setView('3d')}
          >
            3D
          </button>
          <button type="button" aria-pressed={effectiveView === '2d'} onClick={() => setView('2d')}>
            2D
          </button>
        </div>
        <SearchBox paths={paths} onSelect={select} />
      </header>

      {reanalyse ? (
        <ReanalyseStrip
          repo={`${repo.owner}/${repo.name}`}
          source={source}
          analysedAt={analysedAt}
          headSha={repo.headSha}
          onDone={reanalyse.onDone}
          stale={reanalyse.stale}
          onReload={reanalyse.onReload}
        />
      ) : null}

      <p className={st.sr} role="status" aria-live="polite">
        {selectedPath === null ? '' : `Selected ${selectedPath}`}
      </p>

      <div className={s.panels} data-open={sheetOpen}>
        <button
          ref={sheetButton}
          type="button"
          className={s.sheetButton}
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((o) => !o)}
        >
          {sheetOpen ? 'Hide report card and details' : 'Show report card and details'}
        </button>
        <ReportCard report={report} selectedPath={selectedPath} onSelect={select}>
          <FolderList
            folders={folders}
            chosenPath={chosenFolder}
            onPreview={setPreviewFolder}
            onChoose={chooseFolder}
          />
        </ReportCard>
        <DetailsPanel
          file={selectedFile}
          selectedPath={selectedPath}
          repo={repo}
          headSha={repo.headSha}
          now={win.to}
        />
      </div>

      <main id="main" ref={main} tabIndex={-1} className={s.canvas}>
        <div className={s.fill}>
          {effectiveView === '3d' ? (
            <CityCanvas
              ref={city}
              layout={layout}
              colours={colours}
              selectedPath={selectedPath}
              arcs={arcs}
              badgedDistricts={badged}
              highlightedDistrict={highlightedFolder}
              onSelect={onCitySelect}
              tooltipText={cityTooltip}
              onError={() => setNoWebGL(true)}
            />
          ) : (
            <TreemapView
              files={files}
              colourOf={colourOf}
              selectedPath={selectedPath}
              badgedDistricts={badged}
              districtPaths={districtPaths}
              highlightedDistrict={highlightedFolder}
              tooltipText={treemapText}
              onSelect={(path) => {
                setSelectedPath(path);
                if (path !== null) setSheetOpen(true);
              }}
            />
          )}
        </div>
        {noWebGL ? (
          <p className={s.notice} role="status">
            3D needs WebGL, which this browser has turned off or does not support, so the 2D treemap
            is shown instead.
          </p>
        ) : null}
        <div className={s.overlay}>
          <label className={s.picker}>
            Colour by
            <select value={mode} onChange={(e) => setMode(e.target.value as ColourMode)}>
              {COLOUR_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <div className={s.stack}>
            <ThinHistoryNote thin={stats.thinHistory} mode={mode} commits={win.commits} />
            <Legend mode={mode} ctx={ctx} stats={stats} />
          </div>
        </div>
      </main>
    </div>
  );
}
