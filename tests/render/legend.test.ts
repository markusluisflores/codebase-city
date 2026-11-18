import { describe, expect, it } from 'vitest';
import type { District } from '@/lib/analysis/types';
import { COLD, COLOUR_MODES, OTHERS, AUTHOR_COLOURS } from '@/lib/render/colours';
import { districtBadges, legendFor } from '@/lib/render/legend';
import { truncateTip } from '@/lib/render/text';

const HEX = /^#[0-9a-f]{6}$/i;

describe('legendFor', () => {
  it('exists for all six modes, each with stops that have colour and text, and the heuristic note', () => {
    for (const mode of COLOUR_MODES) {
      const l = legendFor(mode);
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.stops.length).toBeGreaterThan(1);
      for (const s of l.stops) {
        expect(s.colour).toMatch(HEX);
        expect(s.text.length).toBeGreaterThan(0);
      }
      expect(l.note.toLowerCase()).toContain('heuristic');
    }
  });

  it('has exactly six age stops with the specified labels', () => {
    expect(legendFor('age').stops.map((s) => s.text)).toEqual([
      '30 days or less',
      '90 days or less',
      '180 days or less',
      '365 days or less',
      '730 days or less',
      'older than window',
    ]);
  });

  it('includes the grey "no activity in window" stop in other history modes but not age', () => {
    for (const mode of ['hotspot', 'churn', 'bugfix', 'ownership'] as const) {
      const g = legendFor(mode).stops.find((s) => s.colour === COLD);
      expect(g?.text.startsWith('no activity in window')).toBe(true);
    }
    expect(legendFor('age').stops.some((s) => s.colour === COLD)).toBe(false);
  });

  it('ownership: up to 8 author stops plus others, others differs from the grey, note explains the outline', () => {
    const owners = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, name: `Dev ${i}` }));
    const l = legendFor('ownership', { owners });
    const authors = l.stops.filter((s) => AUTHOR_COLOURS.includes(s.colour));
    expect(authors).toHaveLength(8);
    expect(l.stops.find((s) => s.text === 'others')?.colour).toBe(OTHERS);
    expect(OTHERS).not.toBe(COLD);
    expect(l.note.toLowerCase()).toContain('outline');
    expect(l.stops.filter((s) => s.text === 'Dev 0')).toHaveLength(1);
  });

  it('language: lists given languages (max 7) plus others', () => {
    const languages = Array.from({ length: 10 }, (_, i) => `Lang${i}`);
    const l = legendFor('language', { languages });
    expect(l.stops.map((s) => s.text)).toEqual([...languages.slice(0, 7), 'others']);
  });

  it('bugfix legend names the 3-change minimum', () => {
    expect(legendFor('bugfix').stops.some((s) => /fewer than 3 changes/.test(s.text))).toBe(true);
  });

  it('keeps repo-derived names as plain data (no markup stripping or interpretation)', () => {
    const l = legendFor('ownership', {
      owners: [{ key: 'k', name: '<img src=x onerror=alert(1)>' }],
    });
    expect(l.stops[0]!.text).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('districtBadges', () => {
  const d = (over: Partial<District>): District => ({
    path: 'src',
    singleOwner: false,
    ownerKey: null,
    ownerName: null,
    ownerShare: 0,
    changes: 0,
    ...over,
  });

  it('returns only single-owner districts with name and share', () => {
    const out = districtBadges([
      d({ path: 'a', singleOwner: true, ownerName: 'Ada', ownerShare: 0.86, ownerKey: 'k' }),
      d({ path: 'b' }),
    ]);
    expect(out).toEqual([{ path: 'a', ownerName: 'Ada', share: 0.86 }]);
  });

  it('skips a flagged district with no owner name', () => {
    expect(districtBadges([d({ singleOwner: true, ownerName: null })])).toEqual([]);
  });
});

describe('truncateTip', () => {
  it('leaves short text alone and cuts long text to 200 characters', () => {
    expect(truncateTip('abc')).toBe('abc');
    expect(truncateTip('x'.repeat(300))).toHaveLength(200);
    expect(truncateTip('y'.repeat(200))).toHaveLength(200);
  });

  it('does not split a surrogate pair', () => {
    const cut = truncateTip('a'.repeat(199) + '😀');
    expect(cut).toHaveLength(200);
    expect(cut.endsWith('…')).toBe(true);
  });
});
