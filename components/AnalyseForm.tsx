'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  JOB_PHASES,
  PHASE_LABEL,
  POLL_MS,
  isActivePhase,
  type ActivePhase,
} from '@/lib/analyse/phases';
import { parseRepoInput } from '@/lib/repo/url';
import { ErrorState } from './ErrorState';
import s from './states.module.css';

type Step =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; jobId: string; phase: ActivePhase }
  | { kind: 'needPassword'; busy: boolean; error: string | null }
  | { kind: 'done' }
  | { kind: 'error'; code: string };

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as Json) : {};
  } catch {
    return {};
  }
}

const codeOf = (body: Json): string =>
  typeof body.error === 'string' ? body.error : 'internal_error';

/** How many polls in a row may get no reply before the form gives up. */
const MAX_POLL_FAILURES = 3;

/**
 * The analyse form: a repo input, then (when the visitor has no session) a password prompt, then the
 * job's phases while it runs, then a hand-off to the viewer. Neither the repo nor the password goes in
 * a URL: both travel as JSON bodies. The password is read from the form at submit time, never kept in
 * state, and the field is cleared afterwards.
 */
export function AnalyseForm({
  initialRepo = '',
  onDone,
}: {
  initialRepo?: string;
  /** Called instead of navigating, for a page that already shows this repo and just needs to reload it. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [repo, setRepo] = useState(initialRepo);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const target = useRef<string | null>(null); // lower-case "owner/name" the viewer link points at
  const passwordRef = useRef<HTMLInputElement>(null);
  const routerRef = useRef(router);
  const doneRef = useRef(onDone);
  const id = useId();
  const jobId = step.kind === 'running' ? step.jobId : null;

  useEffect(() => {
    routerRef.current = router;
    doneRef.current = onDone;
  });

  // The poll loop for the current job: one timer at a time, and the cleanup stops everything when the
  // job changes or the component unmounts, so no timer outlives the form or stacks on another.
  useEffect(() => {
    if (jobId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
          signal: controller.signal,
        });
        const body = await readJson(res);
        if (controller.signal.aborted) return;
        failures = 0;
        if (res.status === 401) return setStep({ kind: 'needPassword', busy: false, error: null });
        if (!res.ok) return setStep({ kind: 'error', code: codeOf(body) });
        if (body.phase === 'done') {
          setStep({ kind: 'done' });
          return finish(routerRef.current, target.current, doneRef.current);
        }
        if (body.phase === 'failed') {
          const code = typeof body.errorCode === 'string' ? body.errorCode : 'internal_error';
          return setStep({ kind: 'error', code });
        }
        if (isActivePhase(body.phase)) {
          const phase = body.phase;
          setStep((cur) => (cur.kind === 'running' ? { ...cur, phase } : cur));
        }
      } catch {
        if (controller.signal.aborted) return;
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) return setStep({ kind: 'error', code: 'network' });
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (step.kind === 'needPassword' && !step.busy) passwordRef.current?.focus();
  }, [step]);

  async function start() {
    const parsed = parseRepoInput(repo);
    if (!parsed) return setStep({ kind: 'error', code: 'invalid_repo' });
    target.current = `${parsed.owner}/${parsed.name}`.toLowerCase();
    setStep({ kind: 'starting' });
    let res: Response;
    try {
      res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: `${parsed.owner}/${parsed.name}` }),
      });
    } catch {
      return setStep({ kind: 'error', code: 'network' });
    }
    const body = await readJson(res);
    if (res.status === 401 && body.error === 'unauthorized') {
      return setStep({ kind: 'needPassword', busy: false, error: null });
    }
    if (!res.ok) return setStep({ kind: 'error', code: codeOf(body) });
    if (
      body.status === 'cached' &&
      typeof body.owner === 'string' &&
      typeof body.name === 'string'
    ) {
      target.current = `${body.owner}/${body.name}`.toLowerCase();
      setStep({ kind: 'done' });
      return finish(routerRef.current, target.current, doneRef.current);
    }
    if (body.status === 'job' && typeof body.id === 'string') {
      return setStep({ kind: 'running', jobId: body.id, phase: 'queued' });
    }
    setStep({ kind: 'error', code: 'unreadable' });
  }

  function onAnalyse(e: FormEvent) {
    e.preventDefault();
    if (repo.trim() !== '') void start();
  }

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    if (password === '') return;
    setStep({ kind: 'needPassword', busy: true, error: null });
    let res: Response;
    try {
      res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      return setStep({ kind: 'error', code: 'unavailable' });
    }
    form.reset();
    if (res.status === 204) return void start();
    const code = codeOf(await readJson(res));
    if (code === 'wrong_password' || code === 'too_many_attempts') {
      return setStep({ kind: 'needPassword', busy: false, error: code });
    }
    setStep({ kind: 'error', code });
  }

  const busy = step.kind === 'starting' || step.kind === 'running' || step.kind === 'done';
  const phaseIndex = step.kind === 'running' ? JOB_PHASES.indexOf(step.phase) : -1;
  let announce = '';
  if (step.kind === 'starting') announce = 'Starting the analysis.';
  else if (step.kind === 'running') {
    announce = `Step ${phaseIndex + 1} of ${JOB_PHASES.length}: ${PHASE_LABEL[step.phase]}.`;
  } else if (step.kind === 'done') announce = 'Done. Opening the city.';

  return (
    <div className={s.form}>
      <form onSubmit={onAnalyse} aria-busy={busy}>
        <label htmlFor={`${id}-repo`}>GitHub repository (owner/name or a github.com link)</label>
        <div className={s.row}>
          <input
            id={`${id}-repo`}
            name="repo"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
            placeholder="vercel/next.js"
            value={repo}
            disabled={busy}
            onChange={(e) => setRepo(e.target.value)}
          />
          <button type="submit" className={s.button} disabled={busy || repo.trim() === ''}>
            Analyse
          </button>
        </div>
      </form>

      <div role="status" aria-live="polite" className={s.sr}>
        {announce}
      </div>
      {step.kind === 'running' || step.kind === 'done' ? (
        <ol className={s.phases} aria-label="Analysis progress">
          {JOB_PHASES.map((p, i) => (
            <li
              key={p}
              data-state={
                step.kind === 'done' || i < phaseIndex
                  ? 'done'
                  : i === phaseIndex
                    ? 'current'
                    : 'todo'
              }
              aria-current={i === phaseIndex ? 'step' : undefined}
            >
              {PHASE_LABEL[p]}
            </li>
          ))}
        </ol>
      ) : null}

      {step.kind === 'needPassword' ? (
        <form onSubmit={onPassword} aria-busy={step.busy}>
          <p>Enter the demo password to analyse a repository.</p>
          <label htmlFor={`${id}-pw`}>Demo password</label>
          <div className={s.row}>
            <input
              id={`${id}-pw`}
              ref={passwordRef}
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={200}
              required
              disabled={step.busy}
            />
            <button type="submit" className={s.button} disabled={step.busy}>
              Continue
            </button>
          </div>
          {step.error ? <ErrorState code={step.error} /> : null}
        </form>
      ) : null}

      {step.kind === 'error' ? <ErrorState code={step.code} onRetry={() => void start()} /> : null}
    </div>
  );
}

function finish(
  router: ReturnType<typeof useRouter>,
  repo: string | null,
  onDone: (() => void) | undefined,
): void {
  if (onDone) return onDone();
  const [owner, name] = (repo ?? '').split('/');
  if (owner && name) router.push(`/r/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
}
