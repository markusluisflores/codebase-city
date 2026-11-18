'use client';

import Link from 'next/link';
import { errorMessage } from '@/lib/errors';
import { useViewerState } from '@/lib/viewer/useViewerState';
import { AnalyseForm } from './AnalyseForm';
import { ErrorState } from './ErrorState';
import { LoadingSkeleton } from './LoadingSkeleton';
import { Viewer } from './Viewer';
import s from './viewer.module.css';

/** Fetches the stored analysis and shows the matching state: skeleton, viewer, not-analysed prompt, or an error with retry. */
export function ViewerLoader({ owner, repo }: { owner: string; repo: string }) {
  const [state, reload] = useViewerState(owner, repo);
  switch (state.kind) {
    case 'loading':
      return <LoadingSkeleton />;
    case 'notFound':
      return (
        <main id="main" tabIndex={-1} className={s.state}>
          <h1>{`${owner.toLowerCase()}/${repo.toLowerCase()} is not analysed yet`}</h1>
          <p>{errorMessage('analysis_not_found')}</p>
          <AnalyseForm initialRepo={`${owner}/${repo}`} onDone={reload} />
          <p>
            <Link href="/">Back to the gallery</Link>
          </p>
        </main>
      );
    case 'error':
      return (
        <main id="main" tabIndex={-1} className={s.state}>
          <h1>Could not open this analysis</h1>
          <ErrorState code={state.code} onRetry={reload} retryLabel="Try again" />
          <p>
            <Link href="/">Back to the gallery</Link>
          </p>
        </main>
      );
    case 'ready':
      return (
        <Viewer analysis={state.analysis} source={state.source} analysedAt={state.analysedAt} />
      );
  }
}
