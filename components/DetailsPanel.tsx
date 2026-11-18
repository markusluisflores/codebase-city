import type { FileStat } from '@/lib/analysis/types';
import { githubFileUrl } from '@/lib/links';
import { formatAge, formatBytes, percent } from '@/lib/viewer/model';
import s from './viewer.module.css';

export interface DetailsPanelProps {
  file: FileStat | null;
  /** Set when something is selected that has no file behind it (a merged "(other)" block). */
  selectedPath?: string | null;
  repo: { owner: string; name: string };
  headSha: string;
  /** Window end in unix seconds, the reference for "3 days ago". */
  now: number;
}

/** Details for the selected file. Every repo-derived string is rendered as a React text node. */
export function DetailsPanel({ file, selectedPath = null, repo, headSha, now }: DetailsPanelProps) {
  return (
    <aside className={s.right} aria-label="File details">
      <h2 className={s.panelTitle}>Details</h2>
      {file ? (
        <>
          <p className={s.path}>{file.path}</p>
          <dl className={s.facts}>
            <dt>Size</dt>
            <dd>{formatBytes(file.size)}</dd>
            <dt>Changes in window</dt>
            <dd>{file.changes}</dd>
            <dt>Last changed</dt>
            <dd>
              {file.lastChanged === null ? 'older than window' : formatAge(file.lastChanged, now)}
            </dd>
            <dt>Bug-fix commits</dt>
            <dd>{file.bugFixes}</dd>
            <dt>Main author</dt>
            <dd>
              {file.mainAuthor === null
                ? 'no author in the window'
                : `${file.mainAuthor} (${percent(file.mainAuthorShare)})`}
            </dd>
          </dl>
          {file.coChange.length > 0 ? (
            <>
              <h3 className={s.panelTitle} style={{ marginTop: 14 }}>
                Changes together with
              </h3>
              <ul className={s.cochange}>
                {file.coChange.map((c) => (
                  <li key={c.path}>{`${c.path} (${c.shared} commits, ${percent(c.score)})`}</li>
                ))}
              </ul>
            </>
          ) : null}
          <a
            className={s.link}
            href={githubFileUrl(repo, headSha, file.path)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open on GitHub
          </a>
        </>
      ) : selectedPath !== null ? (
        <>
          <p className={s.path}>{selectedPath}</p>
          <p className={s.hint}>
            Small files merged into one block. They have no details of their own.
          </p>
        </>
      ) : (
        <p className={s.hint}>
          Select a file in the city, the report card or the search to see its details.
        </p>
      )}
    </aside>
  );
}
