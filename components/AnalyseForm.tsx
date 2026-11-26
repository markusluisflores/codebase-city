'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useAnalyse } from '@/lib/analyse/useAnalyse';
import { AnalyseProgress } from './AnalyseProgress';
import { ErrorState } from './ErrorState';
import { UnlockPanel } from './UnlockPanel';
import s from './states.module.css';

/**
 * The analyse form: a repo input, the job's phases while it runs, then a hand-off to the viewer. The
 * password is normally asked for before this form is shown (`AnalyseGate`); the inline prompt here is
 * the fallback for a session that ended while the page was open. Neither the repo nor the password goes
 * in a URL: both travel as JSON bodies.
 */
export function AnalyseForm({
  initialRepo = '',
  currentRepo,
  onDone,
  autoFocusRepo = false,
  autoStart = false,
}: {
  initialRepo?: string;
  /** The `owner/name` the page already shows. When the finished analysis is for it, `onDone` runs instead of navigating. */
  currentRepo?: string;
  /** Reloads the page's own repo (used with `currentRepo`). */
  onDone?: () => void;
  /** Moves focus to the repo field on mount (the visitor just unlocked). */
  autoFocusRepo?: boolean;
  /** Starts analysing `initialRepo` on mount (the visitor just unlocked on that repo's page). */
  autoStart?: boolean;
}) {
  const [repo, setRepo] = useState(initialRepo);
  const { step, setStep, start, analysesLeft } = useAnalyse({ currentRepo, onDone });
  const repoRef = useRef<HTMLInputElement>(null);
  const startRef = useRef(start);
  const started = useRef(false);
  const id = useId();

  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    if (autoFocusRepo) repoRef.current?.focus();
  }, [autoFocusRepo]);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void startRef.current(initialRepo);
  }, [autoStart, initialRepo]);

  const busy = step.kind === 'starting' || step.kind === 'running' || step.kind === 'done';

  function onAnalyse(e: FormEvent) {
    e.preventDefault();
    if (repo.trim() !== '') void start(repo);
  }

  return (
    <div className={s.form}>
      <form onSubmit={onAnalyse} aria-busy={busy}>
        <label htmlFor={`${id}-repo`}>GitHub repository (owner/name or a github.com link)</label>
        <div className={s.row}>
          <input
            id={`${id}-repo`}
            ref={repoRef}
            name="repo"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
            placeholder="vercel/next.js"
            value={repo}
            readOnly={busy} // not disabled: focus stays on the field while the job runs
            onChange={(e) => setRepo(e.target.value)}
          />
          <button type="submit" className={s.button} disabled={busy || repo.trim() === ''}>
            Analyse
          </button>
        </div>
      </form>
      {analysesLeft !== null ? (
        <p className={s.note}>
          {analysesLeft === 1 ? '1 analysis left today' : `${analysesLeft} analyses left today`}
        </p>
      ) : null}

      <AnalyseProgress step={step} />

      {step.kind === 'needPassword' ? (
        <UnlockPanel
          intro="Enter the demo password to analyse a repository."
          onUnlocked={() => void start(repo)}
          onFailure={(code) => setStep({ kind: 'error', code })}
        />
      ) : null}

      {step.kind === 'error' ? (
        <ErrorState
          code={step.code}
          onRetry={step.code === 'invalid_repo' ? undefined : () => void start(repo)}
        />
      ) : null}
    </div>
  );
}
