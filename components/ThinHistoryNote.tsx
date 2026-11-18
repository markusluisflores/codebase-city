import type { ColourMode } from '@/lib/render/colours';
import s from './states.module.css';

/** The colour modes that are computed from the commit history (language is read from file names). */
const HISTORY_MODES: readonly ColourMode[] = ['hotspot', 'churn', 'age', 'bugfix', 'ownership'];

export interface ThinHistoryNoteProps {
  /** `stats.thinHistory`: fewer than 20 commits in the window. */
  thin: boolean;
  mode: ColourMode;
  /** Commits in the window, for the sentence. */
  commits: number;
}

/** Warns that history-based colours rest on very few commits. Renders nothing otherwise. */
export function ThinHistoryNote({ thin, mode, commits }: ThinHistoryNoteProps) {
  if (!thin || !HISTORY_MODES.includes(mode)) return null;
  return (
    <p className={s.note}>
      {`Thin history: only ${commits} ${commits === 1 ? 'commit' : 'commits'} in the 24-month window, so these colours are rough.`}
    </p>
  );
}
