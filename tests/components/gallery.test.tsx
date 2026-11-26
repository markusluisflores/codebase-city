// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GalleryGrid } from '@/components/GalleryGrid';
import { galleryCard } from '@/lib/gallery-cards';
import { viewerAnalysis } from '../helpers/viewerFixture';

afterEach(cleanup);

describe('galleryCard', () => {
  it('summarises an analysis: name, top language, date, thumbnail rectangles', () => {
    const card = galleryCard(viewerAnalysis());
    expect(card.owner).toBe('octo');
    expect(card.name).toBe('repo');
    expect(card.language).toBe('TypeScript');
    expect(card.analysedOn).toBe('2024-03-09');
    expect(card.rects.length).toBeGreaterThan(0);
    for (const r of card.rects) expect(r.fill).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('caps thumbnail rectangles', () => {
    const a = viewerAnalysis();
    a.files = Array.from({ length: 2000 }, (_, i) => ({
      ...a.files[0]!,
      path: `d${i % 7}/f${i}.ts`,
    }));
    expect(galleryCard(a).rects.length).toBeLessThanOrEqual(300);
  });
});

describe('GalleryGrid', () => {
  it('renders one link card per repo to /r/owner/name', () => {
    render(<GalleryGrid cards={[galleryCard(viewerAnalysis())]} />);
    const link = screen.getByRole('link', { name: /octo\/repo/ });
    expect(link.getAttribute('href')).toBe('/r/octo/repo');
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.getByText('2024-03-09')).toBeTruthy();
  });

  it('shows the empty state when there are no cards', () => {
    render(<GalleryGrid cards={[]} />);
    expect(screen.getByText(/no repos in the gallery yet/i)).toBeTruthy();
  });
});

describe('GalleryGrid live label', () => {
  it('marks a live card and leaves a curated card unlabelled', () => {
    const curated = galleryCard(viewerAnalysis());
    const live = { ...curated, owner: 'live', name: 'one', live: true };
    render(<GalleryGrid cards={[curated, live]} />);
    expect(screen.getAllByText('Live')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /live\/one/ })).toBeTruthy();
  });
});
