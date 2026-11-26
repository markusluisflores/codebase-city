import Link from 'next/link';
import { THUMB_H, THUMB_W, type GalleryCard } from '@/lib/gallery-cards';
import { EmptyGallery } from './EmptyGallery';
import s from './gallery.module.css';

/** The card grid on the home page, or the empty state. Server-renderable: no hooks, no client code. */
export function GalleryGrid({ cards }: { cards: readonly GalleryCard[] }) {
  if (cards.length === 0) {
    return <EmptyGallery />;
  }
  return (
    <ul className={s.grid}>
      {cards.map((c) => (
        <li key={`${c.owner}/${c.name}`}>
          <Link
            className={s.card}
            href={`/r/${encodeURIComponent(c.owner.toLowerCase())}/${encodeURIComponent(c.name.toLowerCase())}`}
          >
            <svg
              className={s.thumb}
              viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
              aria-hidden="true"
              focusable="false"
            >
              {c.rects.map((r, i) => (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
              ))}
            </svg>
            <span className={s.name}>
              {`${c.owner}/${c.name}`}
              {c.live ? <span className={s.live}>Live</span> : null}
            </span>
            <span className={s.meta}>
              <span>{c.language ?? 'Other'}</span>
              <span>{c.analysedOn}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
