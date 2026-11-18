import s from './states.module.css';

/** Shown when there are no gallery analyses to list. Server-renderable. */
export function EmptyGallery() {
  return (
    <div className={s.empty}>
      <strong>No repos in the gallery yet.</strong>
      <span>Enter a public GitHub repo above to analyse one.</span>
    </div>
  );
}
