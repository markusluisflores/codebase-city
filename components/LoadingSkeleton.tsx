import s from './states.module.css';

/** The viewer's frame while the analysis downloads (it can be several MB). */
export function LoadingSkeleton() {
  return (
    <div className={s.skeleton} role="status" aria-live="polite" aria-busy="true">
      <div className={`${s.skelBar} ${s.pulse}`} />
      <div className={`${s.skelSide} ${s.pulse}`} />
      <main id="main" tabIndex={-1} className={`${s.skelCanvas} ${s.pulse}`}>
        Loading the analysis…
      </main>
      <div className={`${s.skelSide} ${s.pulse}`} />
    </div>
  );
}
