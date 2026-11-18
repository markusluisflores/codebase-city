/** The phases a live analysis shows, in order (the `jobs` table's non-terminal phases). */
export const JOB_PHASES = ['queued', 'cloning', 'reading_history', 'computing'] as const;
export type ActivePhase = (typeof JOB_PHASES)[number];

export const PHASE_LABEL: Record<ActivePhase, string> = {
  queued: 'Waiting for a free slot',
  cloning: 'Fetching the repository history',
  reading_history: 'Reading the commit history',
  computing: 'Working out hotspots and the layout',
};

/** The status route is polled every 2 seconds (spec section 6, flow step 4). */
export const POLL_MS = 2000;

export function isActivePhase(p: unknown): p is ActivePhase {
  return typeof p === 'string' && (JOB_PHASES as readonly string[]).includes(p);
}
