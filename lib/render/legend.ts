import type { District } from '@/lib/analysis/types';
import {
  AGE_COLOURS,
  AUTHOR_COLOURS,
  COLD,
  MAX_LANGUAGES,
  MAX_OWNERS,
  OTHERS,
  SEQUENTIAL,
  type ColourMode,
} from './colours';

export interface LegendStop {
  colour: string;
  text: string;
}

export interface Legend {
  label: string;
  stops: LegendStop[];
  /** Plain-language caveat; every mode says the score is a heuristic. */
  note: string;
}

export interface LegendNames {
  /** Top authors in rank order (key and display name); the first 8 get a stop. */
  owners?: { key: string; name: string }[];
  /** Top languages in rank order; the first 7 get a stop. */
  languages?: string[];
}

const NO_ACTIVITY: LegendStop = { colour: COLD, text: 'no activity in window' };

const zip = (colours: readonly string[], texts: readonly string[]): LegendStop[] =>
  texts.map((text, i) => ({ colour: colours[i]!, text }));

/**
 * Legend for a colour mode. Every stop carries text, so colour is never the only cue. Names for the
 * language and ownership modes come from `names`; without them the stops are generic.
 */
export function legendFor(mode: ColourMode, names: LegendNames = {}): Legend {
  switch (mode) {
    case 'hotspot':
      return {
        label: 'Hotspot score',
        stops: [
          ...zip(SEQUENTIAL, ['0.00', '0.17', '0.33', '0.50', '0.67', '0.83', '1.00']),
          NO_ACTIVITY,
        ],
        note: 'Heuristic: rank of changes times rank of size, a stand-in for "complicated and constantly edited", not a measure of quality.',
      };
    case 'churn':
      return {
        label: 'Changes in window',
        stops: [
          ...zip(SEQUENTIAL, [
            '1 change',
            '2 to 3 changes',
            '4 to 7 changes',
            '8 to 15 changes',
            '16 to 31 changes',
            '32 to 63 changes',
            '64 or more changes',
          ]),
          NO_ACTIVITY,
        ],
        note: "Heuristic: the number of commits that touched the file in the analysis window; renames split a file's history.",
      };
    case 'age':
      return {
        label: 'Last changed',
        stops: zip(AGE_COLOURS, [
          '30 days or less',
          '90 days or less',
          '180 days or less',
          '365 days or less',
          '730 days or less',
          'older than window',
        ]),
        note: 'Heuristic: age is measured back from the end of the analysis window, not from today.',
      };
    case 'bugfix':
      return {
        label: 'Bug-fix share of changes',
        stops: [
          ...zip(SEQUENTIAL, [
            'no bug fixes',
            'up to 10%',
            'up to 20%',
            'up to 35%',
            'up to 50%',
            'up to 70%',
            'over 70%',
          ]),
          { colour: COLD, text: 'no activity in window, or fewer than 3 changes' },
        ],
        note: 'Heuristic: a commit counts as a bug fix when its message looks like one, so the share is approximate.',
      };
    case 'language': {
      const languages = (names.languages ?? []).slice(0, MAX_LANGUAGES);
      const texts =
        languages.length > 0
          ? languages
          : Array.from({ length: MAX_LANGUAGES }, (_, i) => `#${i + 1} by file count`);
      return {
        label: 'Language',
        stops: [...zip(AUTHOR_COLOURS, texts), { colour: OTHERS, text: 'others' }],
        note: 'Heuristic: language is guessed from the file name, not from its contents.',
      };
    }
    case 'ownership': {
      const owners = (names.owners ?? []).slice(0, MAX_OWNERS);
      const texts =
        owners.length > 0
          ? owners.map((o) => o.name)
          : Array.from({ length: MAX_OWNERS }, (_, i) => `author #${i + 1}`);
      return {
        label: 'Main author',
        stops: [...zip(AUTHOR_COLOURS, texts), { colour: OTHERS, text: 'others' }, NO_ACTIVITY],
        note: 'Heuristic: the main author is whoever changed the file most in the window. A district with an orange outline has a single owner.',
      };
    }
  }
}

export interface DistrictBadge {
  path: string;
  ownerName: string;
  /** 0 to 1. */
  share: number;
}

/** The districts flagged single-owner, with owner and share; consumed by the city and the treemap. */
export function districtBadges(districts: readonly District[]): DistrictBadge[] {
  const out: DistrictBadge[] = [];
  for (const d of districts) {
    if (d.singleOwner && d.ownerName !== null) {
      out.push({ path: d.path, ownerName: d.ownerName, share: d.ownerShare });
    }
  }
  return out;
}
