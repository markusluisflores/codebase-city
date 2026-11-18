import type { Analysis } from '@/lib/analysis/types';
import type { ColourContext, ColourMode } from '@/lib/render/colours';
import { legendFor } from '@/lib/render/legend';
import { percent } from '@/lib/viewer/model';
import s from './viewer.module.css';

export interface LegendProps {
  mode: ColourMode;
  ctx: ColourContext;
  stats: Analysis['stats'];
}

/** Legend for the active colour mode, with the always-visible caveats about what the data cannot say. */
export function Legend({ mode, ctx, stats }: LegendProps) {
  const legend = legendFor(mode, {
    owners: ctx.topOwners.map((key) => ({ key, name: ctx.ownerNames?.get(key) ?? 'unknown' })),
    languages: ctx.topLanguages,
  });
  return (
    <section className={s.legend} aria-label="Legend">
      <h2>{legend.label}</h2>
      <ul className={s.stops}>
        {legend.stops.map((stop, i) => (
          <li key={`${i}-${stop.text}`}>
            <span className={s.swatch} style={{ background: stop.colour }} aria-hidden="true" />
            <span>{stop.text}</span>
          </li>
        ))}
      </ul>
      <p>{legend.note}</p>
      {mode === 'bugfix' ? (
        <p>{`Bug-fix match rate: ${percent(stats.bugFixCommitShare)} of commits in the window matched a fix keyword.`}</p>
      ) : null}
      <p>Renames split a file&apos;s history: a renamed file starts over.</p>
      {stats.mailmapApplied ? null : (
        <p>Author aliases are not merged: one person under two names counts as two authors.</p>
      )}
    </section>
  );
}
