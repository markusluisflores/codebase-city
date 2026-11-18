'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadAnalysis, type ViewerState } from './load';

/**
 * Loads the analysis for a repo and returns the state plus a `reload` (the retry button).
 * A change of owner or repo, or a reload, starts a fresh load; a stale response is ignored. The
 * state is "loading" whenever the stored result belongs to an earlier request.
 */
export function useViewerState(owner: string, repo: string): [ViewerState, () => void] {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${owner}/${repo}`;
  const [result, setResult] = useState<{ key: string; state: ViewerState } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadAnalysis(owner, repo, undefined, controller.signal).then((state) => {
      if (!controller.signal.aborted) setResult({ key, state });
    });
    return () => controller.abort();
  }, [owner, repo, key]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const state: ViewerState = result && result.key === key ? result.state : { kind: 'loading' };
  return [state, reload];
}
