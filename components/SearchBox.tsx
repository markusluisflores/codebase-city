'use client';

import { useId, useMemo, useState } from 'react';
import { searchPaths } from '@/lib/viewer/model';
import s from './viewer.module.css';

export interface SearchBoxProps {
  paths: readonly string[];
  onSelect: (path: string) => void;
}

/** File search as an ARIA combobox: type, move with the arrow keys, Enter or click to choose. */
export function SearchBox({ paths, onSelect }: SearchBoxProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const results = useMemo(() => searchPaths(paths, query), [paths, query]);
  const showList = open && results.length > 0;
  const showEmpty = open && query.trim() !== '' && results.length === 0;

  const choose = (path: string) => {
    onSelect(path);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className={s.search}>
      <input
        type="search"
        role="combobox"
        aria-label="Search files"
        aria-expanded={showList}
        aria-controls={showList ? `${id}-list` : undefined}
        aria-activedescendant={showList ? `${id}-${active}` : undefined}
        aria-autocomplete="list"
        placeholder="Search files"
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && results.length > 0) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => (a + 1) % results.length);
          } else if (e.key === 'ArrowUp' && results.length > 0) {
            e.preventDefault();
            setActive((a) => (a - 1 + results.length) % results.length);
          } else if (e.key === 'Enter' && showList) {
            e.preventDefault();
            const path = results[active];
            if (path !== undefined) choose(path);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {showList ? (
        <ul id={`${id}-list`} role="listbox" aria-label="Matching files" className={s.results}>
          {results.map((path, i) => (
            <li
              key={path}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              // Keep focus in the input so the list does not close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(path)}
            >
              {path}
            </li>
          ))}
        </ul>
      ) : null}
      {showEmpty ? (
        <div role="status" className={s.empty}>
          No files match.
        </div>
      ) : null}
    </div>
  );
}
