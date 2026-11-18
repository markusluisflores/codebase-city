import { AnalyseForm } from '@/components/AnalyseForm';
import { GalleryGrid } from '@/components/GalleryGrid';
import s from '@/components/gallery.module.css';
import { listGalleryCards } from '@/lib/gallery';

// The gallery is committed JSON in public/gallery, so the page is rendered once at build time.
export default async function Home() {
  const cards = await listGalleryCards();
  return (
    <main id="main" tabIndex={-1} className={s.page}>
      <section className={s.hero}>
        <h1>
          Codebase <span>City</span>
        </h1>
        <p>See any repo as a city. Find the files to read first.</p>
        <AnalyseForm />
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
