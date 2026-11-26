import { JOB_PHASES, PHASE_LABEL } from '@/lib/analyse/phases';
import type { Step } from '@/lib/analyse/useAnalyse';
import s from './states.module.css';

/**
 * The live region and the phase list for a running analysis. The region is always in the page (so a
 * screen reader hears changes); it is visually hidden unless `visibleMessage` gives it text to show.
 */
export function AnalyseProgress({ step, visibleMessage }: { step: Step; visibleMessage?: string }) {
  const phaseIndex = step.kind === 'running' ? JOB_PHASES.indexOf(step.phase) : -1;
  let announce = '';
  if (step.kind === 'starting') announce = 'Starting the analysis.';
  else if (step.kind === 'running') {
    announce = `Step ${phaseIndex + 1} of ${JOB_PHASES.length}: ${PHASE_LABEL[step.phase]}.`;
  } else if (step.kind === 'done') announce = 'Done. Opening the city.';

  return (
    <>
      <div role="status" aria-live="polite" className={visibleMessage ? s.statusLine : s.sr}>
        {visibleMessage ?? announce}
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
    </>
  );
}
