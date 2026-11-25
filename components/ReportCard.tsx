import type { Report } from '@/lib/analysis/types';
import s from './viewer.module.css';

export interface ReportCardProps {
  report: Report;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Extra sections rendered under the three lists (the folder list). */
  children?: React.ReactNode;
}

const GROUPS: { key: keyof Report; title: string; hint: string }[] = [
  { key: 'readFirst', title: 'Read first', hint: 'Busy files shared by many commits: start here.' },
  { key: 'riskiest', title: 'Riskiest', hint: 'Large, often changed and often fixed.' },
  { key: 'forgotten', title: 'Forgotten', hint: 'Big files nobody has touched in the window.' },
];

function Path({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <>
      <span className={s.dir}>{path.slice(0, cut)}</span>
      <span>{path.slice(cut)}</span>
    </>
  );
}

/** The text-first equivalent of the canvas: files worth opening, as keyboard-selectable buttons. */
export function ReportCard({ report, selectedPath, onSelect, children }: ReportCardProps) {
  return (
    <aside className={s.left} aria-label="Report card">
      <h2 className={s.panelTitle}>Report card</h2>
      {GROUPS.map(({ key, title, hint }) => (
        <section key={key} className={s.group} aria-labelledby={`report-${key}`}>
          <h3 id={`report-${key}`}>{title}</h3>
          <p className={s.hint}>{hint}</p>
          {report[key].length === 0 ? (
            <p className={s.hint}>Nothing in this list for this repo.</p>
          ) : (
            <ol className={s.list}>
              {report[key].map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className={s.entry}
                    data-path={path}
                    aria-pressed={selectedPath === path}
                    onClick={() => onSelect(path)}
                  >
                    <Path path={path} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
      {children}
    </aside>
  );
}
