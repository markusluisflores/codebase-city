'use client';

import Link from 'next/link';
import { useViewerState } from '@/lib/viewer/useViewerState';
import { Viewer } from './Viewer';
import s from './viewer.module.css';

/**
 * Fetches the stored analysis and shows the matching state. Task 15b replaces the loading, not-found
 * and error branches below with the skeleton, the error codes and the retry button (`reload`);
 * the `ready` branch stays as it is.
 */
export function ViewerLoader({ owner, repo }: { owner: string; repo: string }) {
  const [state] = useViewerState(owner, repo);
  switch (state.kind) {
    case 'loading':
      return (
        <div className={s.state} role="status">
          Loading the analysis…
        </div>
      );
    case 'notFound':
      return (
        <main className={s.state}>
          <h1>{`${owner.toLowerCase()}/${repo.toLowerCase()} is not analysed yet`}</h1>
          <p>
            <Link href="/">Analyse it from the home page</Link>, or open one of the repos in the
            gallery.
          </p>
        </main>
      );
    case 'error':
      return (
        <div className={s.state} role="alert">
          {state.message}
        </div>
      );
    case 'ready':
      return (
        <Viewer analysis={state.analysis} source={state.source} analysedAt={state.analysedAt} />
      );
  }
}
