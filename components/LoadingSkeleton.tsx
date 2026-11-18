import s from './states.module.css';

/** The viewer's frame while the analysis downloads (it can be several MB). */
export function LoadingSkeleton() {
  return (
    <div className={s.skeleton}>
      <div className={`${s.skelBar} ${s.pulse}`} />
      <div className={`${s.skelSide} ${s.pulse}`} />
      <main id="main" tabIndex={-1} aria-busy="true" className={`${s.skelCanvas} ${s.pulse}`}>
        <p role="status">Loading the analysis…</p>
      </main>
      <div className={`${s.skelSide} ${s.pulse}`} />
    </div>
  );
}
