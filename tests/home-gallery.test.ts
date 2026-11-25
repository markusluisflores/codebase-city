import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDb } from '@/lib/db/client';
import { backfillCards, listLiveCards } from '@/lib/db/cards';
import { putCached } from '@/lib/db/cache';
import { galleryCard, parseCard, type GalleryCard } from '@/lib/gallery-cards';
import { HOME_CARD_CAP, loadHomeCards, mergeCards } from '@/lib/home-gallery';
import { pgAdapter, useTestDb } from './helpers/pgliteDb';
import { sampleAnalysis } from './helpers/sampleAnalysis';

const card = (owner: string, name: string, live: boolean, on = '2026-11-01'): GalleryCard => ({
  owner,
  name,
  language: 'TypeScript',
  analysedOn: on,
  live,
  rects: [],
});

describe('mergeCards', () => {
  it('lists curated cards first, then live cards in the order given', () => {
    const out = mergeCards(
      [card('a', 'one', false)],
      [card('b', 'two', true), card('c', 'three', true)],
    );
    expect(out.map((c) => c.name)).toEqual(['one', 'two', 'three']);
  });

  it('drops a live card for a curated repo, ignoring case (curated wins)', () => {
    const out = mergeCards([card('Facebook', 'React', false)], [card('facebook', 'react', true)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.live).toBe(false);
  });

  it('drops a repeated live repo', () => {
    expect(mergeCards([], [card('a', 'x', true), card('A', 'X', true)])).toHaveLength(1);
  });

  it('caps the total, keeping curated cards before live ones', () => {
    const curated = Array.from({ length: 20 }, (_, i) => card('c', `r${i}`, false));
    const live = Array.from({ length: 20 }, (_, i) => card('l', `r${i}`, true));
    const out = mergeCards(curated, live);
    expect(out).toHaveLength(HOME_CARD_CAP);
    expect(out.slice(0, 20).every((c) => !c.live)).toBe(true);
    expect(mergeCards(curated, live, 5).every((c) => !c.live)).toBe(true);
  });

  it('is empty when both are', () => {
    expect(mergeCards([], [])).toEqual([]);
  });
});

describe('loadHomeCards', () => {
  const curated = async () => [card('a', 'one', false)];

  it('merges curated and live', async () => {
    const out = await loadHomeCards({
      curated,
      live: async () => [card('b', 'two', true)],
      backfill: async () => 0,
    });
    expect(out.map((c) => c.live)).toEqual([false, true]);
  });

  it('falls back to the curated gallery when the live query fails', async () => {
    const out = await loadHomeCards({
      curated,
      live: async () => {
        throw new Error('database query failed');
      },
      backfill: async () => 0,
    });
    expect(out).toEqual([card('a', 'one', false)]);
  });

  it('still lists live cards when the backfill fails', async () => {
    const out = await loadHomeCards({
      curated,
      live: async () => [card('b', 'two', true)],
      backfill: async () => {
        throw new Error('x');
      },
    });
    expect(out).toHaveLength(2);
  });

  it('shows the curated gallery with no DATABASE_URL (the real, unmocked database layer)', async () => {
    setDb(null);
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(await loadHomeCards({ curated })).toEqual([card('a', 'one', false)]);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it('is empty with no curated and no live cards', async () => {
    expect(
      await loadHomeCards({
        curated: async () => [],
        live: async () => [],
        backfill: async () => 0,
      }),
    ).toEqual([]);
  });

  it('skips the database when the curated set alone fills the cap', async () => {
    const many = Array.from({ length: HOME_CARD_CAP + 3 }, (_, i) => card('c', `r${i}`, false));
    const out = await loadHomeCards({
      curated: async () => many,
      live: async () => {
        throw new Error('must not be called');
      },
    });
    expect(out).toHaveLength(HOME_CARD_CAP);
  });
});

describe('card mapping', () => {
  it('maps an analysis and its analysedAt to a live card', () => {
    const c = galleryCard(sampleAnalysis('Octo', 'Repo'), new Date('2026-11-20T23:59:59Z'));
    expect(c).toMatchObject({
      owner: 'Octo',
      name: 'Repo',
      language: 'TypeScript',
      analysedOn: '2026-11-20',
      live: true,
    });
  });

  it('marks a card without analysedAt as curated, dated by the window end', () => {
    const c = galleryCard(sampleAnalysis());
    expect(c.live).toBe(false);
    expect(c.analysedOn).toBe('2024-03-09');
  });

  it('parseCard accepts its own output and rejects malformed ones', () => {
    const c = galleryCard(sampleAnalysis(), new Date('2026-11-20T00:00:00Z'));
    expect(parseCard(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseCard(null)).toBeNull();
    expect(
      parseCard({ ...c, rects: [{ x: 0, y: 0, w: 1, h: 1, fill: 'url(javascript:x)' }] }),
    ).toBeNull();
    expect(parseCard({ ...c, analysedOn: 'yesterday' })).toBeNull();
  });
});

describe('live cards in Postgres', () => {
  let t: Awaited<ReturnType<typeof useTestDb>>;
  beforeAll(async () => {
    t = await useTestDb();
  });
  beforeEach(async () => {
    setDb(pgAdapter(t.pg));
    await t.reset();
  });

  it('putCached stores a card; listLiveCards returns newest first and honours the limit', async () => {
    await putCached(sampleAnalysis('a', 'old'), new Date('2026-11-01T00:00:00Z'));
    await putCached(sampleAnalysis('b', 'new'), new Date('2026-11-10T00:00:00Z'));
    await putCached(sampleAnalysis('c', 'mid'), new Date('2026-11-05T00:00:00Z'));
    expect((await listLiveCards(24)).map((c) => c.name)).toEqual(['new', 'mid', 'old']);
    expect(await listLiveCards(1)).toHaveLength(1);
    expect((await listLiveCards(24))[0]!.live).toBe(true);
  });

  it('is empty with no rows', async () => {
    expect(await listLiveCards(24)).toEqual([]);
  });

  it('skips a row whose card is missing or malformed', async () => {
    await putCached(sampleAnalysis('a', 'ok'), new Date('2026-11-01T00:00:00Z'));
    await putCached(sampleAnalysis('b', 'bad'), new Date('2026-11-02T00:00:00Z'));
    await putCached(sampleAnalysis('c', 'none'), new Date('2026-11-03T00:00:00Z'));
    await t.pg.exec(`UPDATE analyses SET card = '{"owner":1}'::jsonb WHERE name = 'bad'`);
    await t.pg.exec(`UPDATE analyses SET card = NULL WHERE name = 'none'`);
    expect((await listLiveCards(24)).map((c) => c.name)).toEqual(['ok']);
  });

  it('backfills rows without a card, newest first, up to the limit', async () => {
    await putCached(sampleAnalysis('a', 'one'), new Date('2026-11-01T00:00:00Z'));
    await putCached(sampleAnalysis('b', 'two'), new Date('2026-11-02T00:00:00Z'));
    await t.pg.exec('UPDATE analyses SET card = NULL');
    expect(await backfillCards(1)).toBe(1);
    expect((await listLiveCards(24)).map((c) => c.owner)).toEqual(['b']);
    expect(await backfillCards(5)).toBe(1);
    expect(await listLiveCards(24)).toHaveLength(2);
    expect(await backfillCards(5)).toBe(0);
  });

  it('backfill marks an unparsable row with a sentinel, skips it next time, and still fills later rows', async () => {
    await putCached(sampleAnalysis('a', 'good'), new Date('2026-11-01T00:00:00Z'));
    await putCached(sampleAnalysis('b', 'broken'), new Date('2026-11-02T00:00:00Z'));
    await t.pg.exec('UPDATE analyses SET card = NULL');
    await t.pg.exec(`UPDATE analyses SET analysis = '{"nope":true}'::jsonb WHERE name = 'broken'`);
    // 'broken' is newer, so it is read first; the valid row after it must still be filled.
    expect(await backfillCards(5)).toBe(1);
    expect((await listLiveCards(24)).map((c) => c.name)).toEqual(['good']);
    const sentinel = await t.pg.query<{ card: unknown }>(
      `SELECT card FROM analyses WHERE name = 'broken'`,
    );
    expect(sentinel.rows[0]!.card).toEqual({});
    expect(await backfillCards(5)).toBe(0);
  });

  it('backfill leaves card NULL after a database error, then fills the row on the next call', async () => {
    await putCached(sampleAnalysis('a', 'flaky'), new Date('2026-11-01T00:00:00Z'));
    await t.pg.exec('UPDATE analyses SET card = NULL');
    const real = pgAdapter(t.pg);
    let failed = false;
    setDb({
      query: async (text, params) => {
        if (!failed && text.includes('SELECT analysis')) {
          failed = true;
          throw new Error('transient database error');
        }
        return real.query(text, params);
      },
    });
    expect(await backfillCards(5)).toBe(0);
    expect(failed).toBe(true);
    const after = await t.pg.query<{ card: unknown }>(
      `SELECT card FROM analyses WHERE name = 'flaky'`,
    );
    expect(after.rows[0]!.card).toBeNull();
    expect(await backfillCards(5)).toBe(1);
    expect((await listLiveCards(24)).map((c) => c.name)).toEqual(['flaky']);
  });

  it('a failed card write on a re-analysis clears the old card instead of keeping it', async () => {
    await putCached(sampleAnalysis('a', 'x'), new Date('2026-11-01T00:00:00Z'));
    const real = pgAdapter(t.pg);
    let failed = false;
    setDb({
      query: async (text, params) => {
        if (!failed && text.includes('SET card = $4')) {
          failed = true;
          throw new Error('card write failed');
        }
        return real.query(text, params);
      },
    });
    await putCached(sampleAnalysis('a', 'x'), new Date('2026-11-09T00:00:00Z'));
    expect(failed).toBe(true);
    const rows = await t.pg.query<{ card: unknown }>('SELECT card FROM analyses');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.card).toBeNull();
  });

  it('a failed card write does not fail putCached or lose the analysis', async () => {
    const real = pgAdapter(t.pg);
    setDb({
      query: async (text, params) => {
        if (text.includes('SET card')) throw new Error('column "card" does not exist');
        return real.query(text, params);
      },
    });
    await expect(putCached(sampleAnalysis('a', 'x'), new Date())).resolves.toBeUndefined();
    const rows = await t.pg.query('SELECT 1 FROM analyses');
    expect(rows.rows).toHaveLength(1);
  });
});
