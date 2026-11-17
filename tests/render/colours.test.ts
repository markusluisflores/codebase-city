import { describe, expect, it } from 'vitest';
import type { FileStat } from '@/lib/analysis/types';
import {
  AGE_BUCKET_DAYS,
  AUTHOR_COLOURS,
  COLD,
  COLOUR_MODES,
  OTHERS,
  SEQUENTIAL,
  buildColourContext,
  colourFor,
  type ColourContext,
  type ColourMode,
} from '@/lib/render/colours';

const HEX = /^#[0-9a-f]{6}$/i;
const DAY = 86_400;
const NOW = 1_800_000_000;

function file(over: Partial<FileStat> = {}): FileStat {
  return {
    path: 'src/a.ts',
    size: 1000,
    language: 'TypeScript',
    changes: 10,
    lastChanged: NOW - 5 * DAY,
    bugFixes: 2,
    authors: [{ key: 'aaaaaaaaaaaa', name: 'Ada', share: 0.9 }],
    mainAuthor: 'Ada',
    mainAuthorShare: 0.9,
    coChange: [],
    ...over,
  };
}

function ctxFor(files: FileStat[]): ColourContext {
  return buildColourContext(files, NOW);
}

describe('palettes', () => {
  it('exports a 7-stop sequential ramp and an 8-colour author palette, all valid hex', () => {
    expect(SEQUENTIAL).toHaveLength(7);
    expect(AUTHOR_COLOURS).toHaveLength(8);
    for (const c of [...SEQUENTIAL, ...AUTHOR_COLOURS, OTHERS, COLD]) expect(c).toMatch(HEX);
  });

  it('has no two equal colours among authors, others and the cold grey', () => {
    const all = [...AUTHOR_COLOURS, OTHERS, COLD].map((c) => c.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('colourFor', () => {
  const files = [
    file(),
    file({
      path: 'b.py',
      language: 'Python',
      changes: 3,
      bugFixes: 3,
      lastChanged: NOW - 400 * DAY,
    }),
    file({
      path: 'cold.ts',
      changes: 0,
      bugFixes: 0,
      lastChanged: null,
      mainAuthor: null,
      authors: [],
    }),
    file({ path: 'quiet.ts', changes: 1, bugFixes: 1 }),
  ];
  const ctx = ctxFor(files);

  it('returns valid hex for every mode and every file', () => {
    for (const mode of COLOUR_MODES) {
      for (const f of files) expect(colourFor(mode, f, ctx)).toMatch(HEX);
    }
  });

  it('gives cold files the neutral grey in hotspot, churn, bugfix and ownership modes', () => {
    const cold = files[2]!;
    for (const mode of ['hotspot', 'churn', 'bugfix', 'ownership'] as ColourMode[]) {
      expect(colourFor(mode, cold, ctx)).toBe(COLD);
    }
  });

  it('gives cold files the stalest age bucket colour, not grey', () => {
    const c = colourFor('age', files[2]!, ctx);
    expect(c).not.toBe(COLD);
    expect(c).toBe(colourFor('age', file({ lastChanged: NOW - 800 * DAY }), ctx));
  });

  it('puts a 31-day-old file in the second age bucket and a 731-day-old one in the stalest', () => {
    const second = colourFor('age', file({ lastChanged: NOW - 31 * DAY }), ctx);
    const first = colourFor('age', file({ lastChanged: NOW - 30 * DAY }), ctx);
    const stalest = colourFor('age', file({ lastChanged: NOW - 731 * DAY }), ctx);
    expect(AGE_BUCKET_DAYS).toEqual([30, 90, 180, 365, 730]);
    expect(first).not.toBe(second);
    expect(colourFor('age', file({ lastChanged: NOW - 80 * DAY }), ctx)).toBe(second);
    expect(colourFor('age', file({ lastChanged: NOW - 730 * DAY }), ctx)).not.toBe(stalest);
    expect(colourFor('age', file({ lastChanged: NOW - 3000 * DAY }), ctx)).toBe(stalest);
  });

  it('is grey in bugfix mode for files under 3 changes and coloured from 3', () => {
    expect(colourFor('bugfix', files[3]!, ctx)).toBe(COLD);
    expect(colourFor('bugfix', files[1]!, ctx)).not.toBe(COLD);
  });

  it('maps hotspot 0 to the coldest and 1 to the hottest stop', () => {
    const f = file({ path: 'x.ts' });
    const lo = colourFor('hotspot', f, { ...ctx, hotspot: new Map([['x.ts', 0]]) });
    const hi = colourFor('hotspot', f, { ...ctx, hotspot: new Map([['x.ts', 1]]) });
    expect(lo).toBe(SEQUENTIAL[0]);
    expect(hi).toBe(SEQUENTIAL[6]);
  });

  it('clamps out-of-range and NaN hotspot values to valid colours', () => {
    const f = file({ path: 'x.ts' });
    for (const v of [-5, 7, Number.NaN]) {
      expect(colourFor('hotspot', f, { ...ctx, hotspot: new Map([['x.ts', v]]) })).toMatch(HEX);
    }
  });

  it('colours churn on log2 buckets, hotter with more changes', () => {
    const c1 = colourFor('churn', file({ changes: 1 }), ctx);
    const c8 = colourFor('churn', file({ changes: 8 }), ctx);
    const c64 = colourFor('churn', file({ changes: 64 }), ctx);
    const c900 = colourFor('churn', file({ changes: 900 }), ctx);
    expect(c1).toBe(SEQUENTIAL[0]);
    expect(c64).toBe(SEQUENTIAL[6]);
    expect(c900).toBe(SEQUENTIAL[6]);
    expect(new Set([c1, c8, c64]).size).toBe(3);
  });

  it('colours language by rank, others grey', () => {
    const many = Array.from({ length: 9 }, (_, i) => file({ path: `f${i}.x`, language: `L${i}` }));
    // L0 has most files.
    const more = [
      ...many,
      file({ path: 'g.x', language: 'L0' }),
      file({ path: 'h.x', language: 'Other' }),
    ];
    const c = ctxFor(more);
    expect(colourFor('language', more[0]!, c)).toBe(AUTHOR_COLOURS[0]);
    expect(colourFor('language', more[more.length - 1]!, c)).toBe(OTHERS);
    expect(colourFor('language', more[8]!, c)).toBe(OTHERS);
  });

  it('colours ownership: 8 authors distinct, the 9th and beyond map to others', () => {
    const owners = Array.from({ length: 10 }, (_, i) =>
      file({
        path: `o${i}.ts`,
        mainAuthor: `Dev${i}`,
        authors: [{ key: `${i}`.padStart(12, '0'), name: `Dev${i}`, share: 1 }],
        // earlier authors own more files so the ranking is deterministic
      }),
    );
    const extra = owners.flatMap((o, i) =>
      Array.from({ length: 10 - i }, (_, j) => ({ ...o, path: `o${i}_${j}.ts` })),
    );
    const c = ctxFor(extra);
    const colours = owners.map((o) =>
      colourFor('ownership', { ...o, path: `o${owners.indexOf(o)}_0.ts` }, c),
    );
    expect(new Set(colours.slice(0, 8)).size).toBe(8);
    expect(colours[8]).toBe(OTHERS);
    expect(colours[9]).toBe(OTHERS);
    expect(OTHERS).not.toBe(COLD);
  });

  it('is deterministic', () => {
    for (const mode of COLOUR_MODES) {
      expect(colourFor(mode, files[0]!, ctx)).toBe(colourFor(mode, files[0]!, ctxFor(files)));
    }
  });
});

describe('buildColourContext', () => {
  it('ranks hotspot by change and size percentiles, between 0 and 1', () => {
    const fs = [
      file({ path: 'a', changes: 1, size: 10 }),
      file({ path: 'b', changes: 5, size: 50 }),
      file({ path: 'c', changes: 9, size: 90 }),
    ];
    const { hotspot } = ctxFor(fs);
    expect(hotspot.get('a')!).toBeLessThan(hotspot.get('b')!);
    expect(hotspot.get('b')!).toBeLessThan(hotspot.get('c')!);
    for (const v of hotspot.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('handles an empty file list', () => {
    const c = ctxFor([]);
    expect(c.hotspot.size).toBe(0);
    expect(c.topOwners).toEqual([]);
  });

  it('lists top owners by files owned, ties broken by key', () => {
    const fs = [
      file({ path: '1', authors: [{ key: 'bbbbbbbbbbbb', name: 'B', share: 1 }], mainAuthor: 'B' }),
      file({ path: '2', authors: [{ key: 'aaaaaaaaaaaa', name: 'A', share: 1 }], mainAuthor: 'A' }),
    ];
    expect(ctxFor(fs).topOwners).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });
});
