'use client';

import { useRef, useState } from 'react';
import { useAnalyse } from '@/lib/analyse/useAnalyse';
import { useSession } from '@/lib/auth/useSession';
import { formatDay, shortSha } from '@/lib/viewer/model';
import { AnalyseProgress } from './AnalyseProgress';
import { ErrorState } from './ErrorState';
import { UnlockPanel } from './UnlockPanel';
import s from './states.module.css';
import v from './viewer.module.css';

/**
 * "Check for new commits" for a live analysis, under the viewer's top bar. Only for an unlocked visitor
 * and only for a live analysis (gallery snapshots refresh when the site is rebuilt). It posts the same
 * `/api/analyze` as the first analysis: the server answers "cached" (free) when the head has not moved
 * and starts a job when it has, so the cost note is shown before anything runs. The old city stays on
 * screen while the job runs; `onDone` reloads the data when it finishes.
 */
export function ReanalyseStrip({
  repo,
  source,
  analysedAt,
  headSha,
  onDone,
  stale = false,
  onReload,
}: {
  /** `owner/name` of the analysis on screen. */
  repo: string;
  source: 'gallery' | 'live';
  analysedAt: string | null;
  headSha: string;
  /** Reloads the viewer's data (the job finished). */
  onDone: () => void;
  /** The reload still returned the previous analysis (the CDN copy lives for up to 5 minutes). */
  stale?: boolean;
  onReload?: () => void;
}) {
  const { session } = useSession();
  const { step, setStep, start, analysesLeft } = useAnalyse({
    currentRepo: repo,
    onDone,
    refresh: true,
  });
  const [confirming, setConfirming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);

  const active = step.kind !== 'idle';
  const canCheck = session.state === 'unlocked' || active;
  if (source !== 'live' || !(canCheck || stale)) return null;
  const busy = step.kind === 'starting' || step.kind === 'running' || step.kind === 'done';

  const upToDate =
    step.kind === 'upToDate'
      ? `Up to date. No new commits since ${shortSha(step.headSha ?? headSha)}${
          (step.analysedAt ?? analysedAt)
            ? ` (${formatDay(Date.parse((step.analysedAt ?? analysedAt)!) / 1000)})`
            : ''
        }.`
      : undefined;

  function cancel() {
    setConfirming(false);
    button.current?.focus();
  }

  return (
    <section ref={region} tabIndex={-1} className={v.strip} aria-label="Re-analyse this repository">
      {canCheck ? (
        <div className={v.stripRow}>
          <button
            ref={button}
            type="button"
            className={s.button}
            aria-expanded={confirming}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Check for new commits
          </button>
          {analysesLeft !== null ? (
            <span className={s.noteInline}>
              {analysesLeft === 1 ? '1 analysis left today' : `${analysesLeft} analyses left today`}
            </span>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div className={s.disclosure} onKeyDown={(e) => e.key === 'Escape' && cancel()}>
          <p>
            If this repository has new commits, this runs a new analysis. It uses one of the shared
            daily and monthly limit and up to 4 minutes of Sandbox time. If nothing has changed, it
            costs nothing.
          </p>
          <div className={s.row}>
            <button
              type="button"
              className={s.button}
              autoFocus
              onClick={() => {
                setConfirming(false);
                region.current?.focus(); // the confirm button is about to unmount; keep focus in the strip
                void start(repo);
              }}
            >
              Check and re-analyse
            </button>
            <button type="button" className={s.secondaryButton} onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <AnalyseProgress step={step} visibleMessage={upToDate} />

      {step.kind === 'needPassword' ? (
        <UnlockPanel
          intro="Your unlock ended. Enter the demo password to continue."
          onUnlocked={() => void start(repo)}
          onFailure={(code) => setStep({ kind: 'error', code })}
        />
      ) : null}

      {step.kind === 'error' ? (
        <ErrorState code={step.code} onRetry={() => void start(repo)} />
      ) : null}

      {stale && step.kind !== 'running' ? (
        <div role="status" className={s.statusLine}>
          <p>The new analysis is saved. This page may show the previous one for up to 5 minutes.</p>
          {onReload ? (
            <button type="button" className={s.secondaryButton} onClick={onReload}>
              Reload
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
