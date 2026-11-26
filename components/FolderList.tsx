import s from './viewer.module.css';

export interface FolderEntry {
  path: string;
  files: number;
}

export interface FolderListProps {
  folders: readonly FolderEntry[];
  /** The folder the viewer picked from this list, or null. */
  chosenPath: string | null;
  /** Called with a path on hover or keyboard focus, and `null` when the pointer or focus leaves. */
  onPreview: (path: string | null) => void;
  /** Called when a folder is clicked or activated; choosing the chosen folder again clears it. */
  onChoose: (path: string) => void;
}

/** Rows shown before the "N more" note; search finds files in the rest. */
export const FOLDER_ROWS = 40;

/**
 * The text equivalent of the district labels: the repo's top-level and second-level folders, largest
 * first. Hovering or focusing a row tints that district in the 3D city and the treemap; clicking
 * keeps it tinted and, in 3D, flies the camera there.
 */
export function FolderList({ folders, chosenPath, onPreview, onChoose }: FolderListProps) {
  const sorted = [...folders].sort(
    (a, b) => b.files - a.files || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const shown = sorted.slice(0, FOLDER_ROWS);
  return (
    <details className={s.folders}>
      <summary className={s.foldersSummary}>
        Folders <span className={s.foldersCount}>{folders.length}</span>
      </summary>
      <p className={s.hint}>
        Districts in the city: hover to find one, click to keep it lit (and fly there in 3D).
        Largest first, with file counts.
      </p>
      <ul className={s.folderList} onMouseLeave={() => onPreview(null)}>
        {shown.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={s.folderRow}
              data-path={f.path}
              aria-pressed={chosenPath === f.path}
              onMouseEnter={() => onPreview(f.path)}
              onFocus={() => onPreview(f.path)}
              onBlur={() => onPreview(null)}
              onClick={() => onChoose(f.path)}
            >
              <span className={s.folderName}>{f.path}</span>
              <span className={s.folderFiles}>{f.files}</span>
            </button>
          </li>
        ))}
      </ul>
      {sorted.length > shown.length ? (
        <p
          className={s.hint}
        >{`${sorted.length - shown.length} smaller folders not listed. Search finds their files.`}</p>
      ) : null}
    </details>
  );
}
