import { afterEach, describe, expect, it, vi } from 'vitest';
import { canUseWebGL, flyToMode, relativeLuminance } from '@/lib/a11y';
import {
  AUTHOR_COLOURS,
  AGE_COLOURS,
  COLD,
  OTHERS,
  SEQUENTIAL,
  TOKENS,
  type ColourMode,
} from '@/lib/render/colours';
import { legendFor } from '@/lib/render/legend';

afterEach(() => vi.unstubAllGlobals());

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white (WCAG)', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
  });
  it('accepts upper case, and 3-digit shorthand', () => {
    expect(relativeLuminance('#FFF')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#E69F00')).toBeCloseTo(relativeLuminance('#e69f00'), 9);
  });
  it('matches the WCAG value for a mid colour', () => {
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3);
  });
  it('rejects a malformed colour', () => {
    expect(() => relativeLuminance('red')).toThrow();
  });
});

// The plan asked for adjacent stops at least 0.1 apart. The original Night Ember ramp had adjacent WCAG
// luminance gaps of 0.03 to 0.36, so the executor set the threshold to 0.03 on 2026-11-17. On 2026-11-26
// Markus approved lifting the cold end of the ramp (its darkest stop was 1.04:1 against the floor plate, so
// low-activity buildings vanished). The lifted ramp's gaps run from 0.059 to 0.24, so the threshold is now
// 0.05, and the dimmest stop of every ramp must be at least 2:1 against the floor plate (MIN_FLOOR_CONTRAST).
// Every legend stop also carries a number or a word, so colour is never the only signal.
const MIN_GAP = 0.05;
const MIN_FLOOR_CONTRAST = 2;

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('sequential legends', () => {
  const cases: { mode: ColourMode; direction: 1 | -1 }[] = [
    { mode: 'hotspot', direction: 1 }, // cold first, hot last
    { mode: 'churn', direction: 1 },
    { mode: 'bugfix', direction: 1 },
    { mode: 'age', direction: -1 }, // listed newest (hot) first, "older than window" (cold) last
  ];
  for (const { mode, direction } of cases) {
    it(`${mode}: ramp stops get strictly lighter from cold to hot, gaps of at least ${MIN_GAP}`, () => {
      const stops = legendFor(mode).stops.filter(
        (s) => SEQUENTIAL.includes(s.colour) || AGE_COLOURS.includes(s.colour),
      );
      expect(stops.length).toBeGreaterThanOrEqual(6);
      const lum = stops.map((s) => relativeLuminance(s.colour));
      const coldToHot = direction === 1 ? lum : [...lum].reverse();
      for (let i = 1; i < coldToHot.length; i++) {
        expect(coldToHot[i]! - coldToHot[i - 1]!).toBeGreaterThanOrEqual(MIN_GAP);
      }
    });
  }
});

describe('cold end against the floor plate', () => {
  // Age mode never uses stop 0 (its stalest bucket is SEQUENTIAL[1], 3.07:1), so its check is on that stop.
  const coldStop = (mode: ColourMode, direction: 1 | -1): string => {
    const stops = legendFor(mode).stops.filter(
      (s) => SEQUENTIAL.includes(s.colour) || AGE_COLOURS.includes(s.colour),
    );
    return (direction === 1 ? stops[0] : stops[stops.length - 1])!.colour;
  };
  for (const [mode, direction] of [
    ['hotspot', 1],
    ['churn', 1],
    ['bugfix', 1],
    ['age', -1],
  ] as const) {
    it(`${mode}: the dimmest stop is at least ${MIN_FLOOR_CONTRAST}:1 against the floor plate`, () => {
      expect(contrast(coldStop(mode, direction), TOKENS.surface)).toBeGreaterThanOrEqual(
        MIN_FLOOR_CONTRAST,
      );
    });
  }
  it('the no-activity grey stays at least 3:1 against the floor plate', () => {
    expect(contrast(COLD, TOKENS.surface)).toBeGreaterThanOrEqual(3);
  });
});

// Machado et al. 2009, severity 1.0, applied to linear RGB; distance is OKLab x 100.
const MACHADO = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;
const toLinear = (hex: string): number[] =>
  [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
const oklab = ([r, g, b]: number[]): number[] => {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia';
const seen = (hex: string, kind: Vision): number[] => {
  const c = toLinear(hex);
  if (kind === 'normal') return c;
  if (kind === 'achromatopsia') {
    const y = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    return [y, y, y];
  }
  return MACHADO[kind].map((row) => Math.min(1, row[0] * c[0]! + row[1] * c[1]! + row[2] * c[2]!));
};
const distance = (a: string, b: string, kind: Vision): number => {
  const x = oklab(seen(a, kind));
  const y = oklab(seen(b, kind));
  return 100 * Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
};

describe('the two greys', () => {
  it('"others" is at least 2:1 lighter than the no-activity grey', () => {
    const ratio = (relativeLuminance(OTHERS) + 0.05) / (relativeLuminance(COLD) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(2);
  });
  // Normal vision: #bdbdbd sits next to the near-white 8th author colour (lightness ratio only 1.7:1),
  // so the plain colour distance must stay clear too (floor 8, the dataviz target).
  it('"others" stays at least 8 from every author colour with normal vision', () => {
    for (const c of AUTHOR_COLOURS) expect(distance(OTHERS, c, 'normal')).toBeGreaterThanOrEqual(8);
  });
  // Floor of 5: the old #999999 was 1.9 away from the pink under deuteranopia and achromatopsia.
  for (const kind of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'] as const) {
    it(`"others" stays at least 5 from every author colour under ${kind}`, () => {
      for (const c of AUTHOR_COLOURS) {
        expect(distance(OTHERS, c, kind)).toBeGreaterThanOrEqual(5);
      }
    });
  }
});

// Lifting the ramp moved its cold end next to the no-activity grey in lightness (about 1.7:1 against stop 0),
// so hue has to separate them. Floor of 6 (the dataviz floor with a text label, and every legend stop has
// one). Achromatopsia has no hue, so it is not checked here: the legend text carries the difference.
describe('the no-activity grey against the ramp', () => {
  for (const kind of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
    it(`stays at least 6 from every ramp stop under ${kind}`, () => {
      for (const c of SEQUENTIAL) expect(distance(COLD, c, kind)).toBeGreaterThanOrEqual(6);
    });
  }
});

describe('categorical palettes', () => {
  it('language and ownership legends use distinct hexes', () => {
    for (const mode of ['language', 'ownership'] as const) {
      const colours = legendFor(mode).stops.map((s) => s.colour.toLowerCase());
      expect(new Set(colours).size).toBe(colours.length);
    }
    expect(new Set(AUTHOR_COLOURS.map((c) => c.toLowerCase())).size).toBe(AUTHOR_COLOURS.length);
  });
});

describe('flyToMode', () => {
  it('jumps under reduced motion and animates otherwise', () => {
    expect(flyToMode(true)).toBe('jump');
    expect(flyToMode(false)).toBe('animate');
  });
});

describe('canUseWebGL', () => {
  it('is false when the context cannot be created', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    expect(canUseWebGL()).toBe(false);
  });
  it('is false when getContext throws', () => {
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => {
          throw new Error('blocked');
        },
      }),
    });
    expect(canUseWebGL()).toBe(false);
  });
  it('is true when a context is returned', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({}) }) });
    expect(canUseWebGL()).toBe(true);
  });
  it('is false with no document (server)', () => {
    vi.stubGlobal('document', undefined);
    expect(canUseWebGL()).toBe(false);
  });
});
