import { AnalyseForm } from '@/components/AnalyseForm';
import { GalleryGrid } from '@/components/GalleryGrid';
import s from '@/components/gallery.module.css';
import { loadHomeCards } from '@/lib/home-gallery';

// Curated cards come from committed JSON, live ones from Postgres. The page is regenerated at most once a
// minute (the CDN serves it in between), so a repo analysed live shows up within about a minute without a
// database read per visit. With no database the page is the curated gallery alone.
export const revalidate = 60;

export default async function Home() {
  const cards = await loadHomeCards();
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
