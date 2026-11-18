import { describe, expect, it } from 'vitest';
import { districtTooltip, formatDay, percent, searchPaths, shortSha } from '@/lib/viewer/model';

describe('percent', () => {
  it('renders 0 as 0%, not blank, and rounds', () => {
    expect(percent(0)).toBe('0%');
    expect(percent(0.86)).toBe('86%');
    expect(percent(0.1234)).toBe('12%');
    expect(percent(1)).toBe('100%');
  });
});

describe('districtTooltip', () => {
  it('reads single owner: name (share%)', () => {
    expect(districtTooltip({ ownerName: 'Ada', share: 0.86 })).toBe('single owner: Ada (86%)');
  });
});

describe('formatDay and shortSha', () => {
  it('formats unix seconds as a UTC date', () => {
    expect(formatDay(1_700_000_000)).toBe('2023-11-14');
  });
  it('shortens a sha to 7 characters', () => {
    expect(shortSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
  });
});

describe('searchPaths', () => {
  const paths = ['src/app.ts', 'src/lib/Apple.ts', 'docs/readme.md', 'src/lib/util/apt.ts'];
  it('is empty for a blank query', () => {
    expect(searchPaths(paths, '  ')).toEqual([]);
  });
  it('matches case-insensitively, file-name matches first', () => {
    expect(searchPaths(paths, 'app')).toEqual(['src/app.ts', 'src/lib/Apple.ts']);
    expect(searchPaths(paths, 'LIB')).toEqual(['src/lib/Apple.ts', 'src/lib/util/apt.ts']);
  });
  it('limits the result count', () => {
    const many = Array.from({ length: 50 }, (_, i) => `f/file${i}.ts`);
    expect(searchPaths(many, 'file', 8)).toHaveLength(8);
  });
});
