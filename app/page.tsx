import { GalleryGrid } from '@/components/GalleryGrid';
import s from '@/components/gallery.module.css';
import { listGalleryCards } from '@/lib/gallery';

// The gallery is committed JSON in public/gallery, so the page is rendered once at build time.
export default async function Home() {
  const cards = await listGalleryCards();
  return (
    <main className={s.page}>
      <section className={s.hero}>
        <h1>
          Codebase <span>City</span>
        </h1>
        <p>See any repo as a city. Find the files to read first.</p>
        {/* Task 15b: the gated analyse form goes here, between the hero text and the gallery. */}
      </section>
      <section aria-labelledby="gallery-heading">
        <h2 id="gallery-heading" className={s.heading}>
          Gallery
        </h2>
        <GalleryGrid cards={cards} />
      </section>
    </main>
  );
}
