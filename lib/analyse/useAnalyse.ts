'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseRepoInput } from '@/lib/repo/url';
import { isActivePhase, POLL_MS, type ActivePhase } from './phases';

export type Step =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; jobId: string; phase: ActivePhase }
  /** The server said 401: the session is missing or ended. The caller shows the password form. */
  | { kind: 'needPassword' }
  | { kind: 'done' }
  /** Refresh mode only: the server answered "cached", so there is nothing new to analyse. */
  | { kind: 'upToDate'; headSha: string | null; analysedAt: string | null }
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

const isKnownPhase = (p: unknown): boolean => p === 'done' || p === 'failed' || isActivePhase(p);

/** How many polls in a row may get no reply before the job gives up. */
const MAX_POLL_FAILURES = 3;

/**
 * The analyse job state machine shared by the analyse form and the re-analyse strip: `start` posts the
 * repo to `/api/analyze`, then the job is polled every 2 seconds and the finished analysis is handed
 * off. Only the repo goes out, as a JSON body. With `refresh`, a "cached" answer ends in `upToDate`
 * instead of opening the viewer (the repo is already on screen).
 */
export function useAnalyse({
  currentRepo,
  onDone,
  refresh = false,
}: {
  /** The `owner/name` the page already shows. A finished analysis of it calls `onDone` instead of navigating. */
  currentRepo?: string;
  onDone?: () => void;
  refresh?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [analysesLeft, setAnalysesLeft] = useState<number | null>(null);
  const target = useRef<string | null>(null); // lower-case "owner/name" the viewer link points at
  const routerRef = useRef(router);
  const doneRef = useRef(onDone);
  const currentRef = useRef(currentRepo);
  const refreshRef = useRef(refresh);
  const jobId = step.kind === 'running' ? step.jobId : null;

  useEffect(() => {
    routerRef.current = router;
    doneRef.current = onDone;
    currentRef.current = currentRepo;
    refreshRef.current = refresh;
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
        if (res.status === 401) return setStep({ kind: 'needPassword' });
        // A server error or an unreadable reply while the job runs is transient: count it and keep polling.
        if (res.status >= 500 || (res.ok && !isKnownPhase(body.phase))) throw new Error('poll');
        failures = 0; // only a good reply resets the count
        if (!res.ok) return setStep({ kind: 'error', code: codeOf(body) });
        if (body.phase === 'done') {
          setStep({ kind: 'done' });
          return finish(routerRef.current, target.current, currentRef.current, doneRef.current);
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

  const start = useCallback(async (input: string): Promise<void> => {
    const parsed = parseRepoInput(input);
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
    if (res.status === 401 && body.error === 'unauthorized')
      return setStep({ kind: 'needPassword' });
    if (!res.ok) return setStep({ kind: 'error', code: codeOf(body) });
    if (typeof body.analysesLeft === 'number') setAnalysesLeft(body.analysesLeft);
    if (
      body.status === 'cached' &&
      typeof body.owner === 'string' &&
      typeof body.name === 'string'
    ) {
      if (refreshRef.current) {
        return setStep({
          kind: 'upToDate',
          headSha: typeof body.headSha === 'string' ? body.headSha : null,
          analysedAt: typeof body.analysedAt === 'string' ? body.analysedAt : null,
        });
      }
      target.current = `${body.owner}/${body.name}`.toLowerCase();
      setStep({ kind: 'done' });
      return finish(routerRef.current, target.current, currentRef.current, doneRef.current);
    }
    if (body.status === 'job' && typeof body.id === 'string') {
      return setStep({ kind: 'running', jobId: body.id, phase: 'queued' });
    }
    setStep({ kind: 'error', code: 'unreadable' });
  }, []);

  return { step, setStep, start, analysesLeft };
}

function finish(
  router: ReturnType<typeof useRouter>,
  repo: string | null,
  current: string | undefined,
  onDone: (() => void) | undefined,
): void {
  if (onDone && repo !== null && repo === current?.toLowerCase()) return onDone();
  const [owner, name] = (repo ?? '').split('/');
  if (owner && name) router.push(`/r/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
}
