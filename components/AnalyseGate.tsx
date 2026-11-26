'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/auth/useSession';
import { AnalyseForm } from './AnalyseForm';
import { ErrorState } from './ErrorState';
import { UnlockPanel } from './UnlockPanel';
import s from './states.module.css';

const dayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function LockIcon({ open }: { open?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d={open ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
    </svg>
  );
}

/**
 * What a visitor sees where the analyse form used to be. Locked (also while the state is still being
 * read): one quiet "Analyse your own repo" button that opens the password panel in place, so the
 * gallery stays the first thing on the page. Unlocked: the repo form, with when the unlock ends and a
 * Lock button. On a repo's own not-analysed page (`initialRepo` given) the repo is already known, so
 * the locked state is just the password with "Unlock and analyse", and unlocking starts the analysis.
 */
export function AnalyseGate({
  initialRepo,
  currentRepo,
  onDone,
}: {
  initialRepo?: string;
  currentRepo?: string;
  onDone?: () => void;
}) {
  const { session, refresh, lock } = useSession();
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [justUnlocked, setJustUnlocked] = useState(false);
  const focusTrigger = useRef(false);
  const [announce, setAnnounce] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const forRepo = initialRepo !== undefined;
  const unlocked = session.state === 'unlocked';

  // Hand focus back to the button once it is on screen again (after Escape, Cancel or Lock).
  useEffect(() => {
    if (focusTrigger.current && trigger.current) {
      focusTrigger.current = false;
      trigger.current.focus();
    }
  });

  async function onUnlocked() {
    setProblem(null);
    if (await refresh()) {
      setJustUnlocked(true);
      setOpen(false);
      setAnnounce(
        forRepo
          ? 'Unlocked. Analysing this repository.'
          : 'Unlocked. You can analyse a repository now.',
      );
    } else {
      setProblem('unavailable'); // the cookie was set but not kept (cookies blocked)
    }
  }

  async function onLock() {
    if (await lock()) {
      setJustUnlocked(false);
      setOpen(false);
      setAnnounce('Locked.');
      focusTrigger.current = true;
    } else {
      setProblem('unavailable');
    }
  }

  // One live region, first child of one wrapper in every state, so it keeps its place in the tree and
  // "Unlocked." and "Locked." are announced instead of the region being replaced.
  let body: ReactNode;
  if (unlocked) {
    body = (
      <>
        <p className={s.unlockedBar}>
          <LockIcon open />
          <span>{`Unlocked until ${dayOf(session.expiresAt)}`}</span>
          <button type="button" className={s.linkButton} onClick={() => void onLock()}>
            Lock
          </button>
        </p>
        {problem ? <ErrorState code={problem} /> : null}
        <AnalyseForm
          initialRepo={initialRepo}
          currentRepo={currentRepo}
          onDone={onDone}
          autoFocusRepo={justUnlocked}
          autoStart={justUnlocked && forRepo}
          onUnlocked={() => void refresh()}
        />
      </>
    );
  } else if (forRepo) {
    // Until the first status answer, show nothing to type into: an already-unlocked visitor must not
    // see a password panel that then turns into the repo form mid-typing.
    body =
      session.state === 'unknown' ? null : (
        <>
          <UnlockPanel
            submitLabel="Unlock and analyse"
            autoFocus={false}
            onUnlocked={() => void onUnlocked()}
          />
          {problem ? <ErrorState code={problem} /> : null}
        </>
      );
  } else {
    body = (
      <>
        <button
          ref={trigger}
          type="button"
          className={s.lockButton}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          <LockIcon />
          Analyse your own repo
        </button>
        <p className={s.gateNote}>
          The gallery below is open to everyone. Analysing a new repo uses a small hosted compute
          budget, so it needs a demo password.
        </p>
        <div id={panelId}>
          {open ? (
            <UnlockPanel
              submitLabel="Unlock"
              onUnlocked={() => void onUnlocked()}
              onCancel={() => {
                setOpen(false);
                focusTrigger.current = true;
              }}
            />
          ) : null}
        </div>
        {problem ? <ErrorState code={problem} /> : null}
      </>
    );
  }

  return (
    <div className={s.gate}>
      <div role="status" aria-live="polite" className={s.sr}>
        {announce}
      </div>
      {body}
    </div>
  );
}
