import { describe, expect, it } from 'vitest';
import { validateHeadSha, validateOwnerName, validateWindowFrom } from '@/lib/repo/validate';

describe('validateOwnerName', () => {
  it.each(['o', 'r-1.x', 'Next.js', 'a_b', '0abc', 'a'.repeat(100)])('accepts %s', (s) => {
    expect(validateOwnerName(s)).toBe(true);
  });

  it.each([
    '.',
    '..',
    '-x',
    '.git',
    '_x',
    'a/b',
    '',
    'a b',
    'a;rm',
    '--upload-pack=x',
    'a\nb',
    'aé',
    'a'.repeat(101),
  ])('rejects %j', (s) => {
    expect(validateOwnerName(s)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(validateOwnerName(undefined as unknown as string)).toBe(false);
    expect(validateOwnerName(5 as unknown as string)).toBe(false);
  });

  it('does not accept a trailing newline (regex $ pitfall)', () => {
    expect(validateOwnerName('abc\n')).toBe(false);
  });
});

describe('validateHeadSha', () => {
  it('accepts 40 lower-case hex characters', () => {
    expect(validateHeadSha('a'.repeat(40))).toBe(true);
    expect(validateHeadSha('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it.each([
    'a'.repeat(39),
    'a'.repeat(41),
    'g'.repeat(40),
    'A'.repeat(40),
    '',
    `${'a'.repeat(40)}\n`,
    `--${'a'.repeat(38)}`,
  ])('rejects %j', (s) => {
    expect(validateHeadSha(s)).toBe(false);
  });
});

describe('validateWindowFrom', () => {
  const MIN = Date.UTC(2000, 0, 1) / 1000;
  const MAX = Date.UTC(2100, 0, 1) / 1000;

  it('accepts in-range integers including the bounds', () => {
    expect(validateWindowFrom(1_700_000_000)).toBe(true);
    expect(validateWindowFrom(MIN)).toBe(true);
    expect(validateWindowFrom(MAX)).toBe(true);
  });

  it('rejects out of range, floats, negatives, non-finite and strings', () => {
    expect(validateWindowFrom(MIN - 1)).toBe(false);
    expect(validateWindowFrom(MAX + 1)).toBe(false);
    expect(validateWindowFrom(1.5)).toBe(false);
    expect(validateWindowFrom(-5)).toBe(false);
    expect(validateWindowFrom(0)).toBe(false);
    expect(validateWindowFrom(NaN)).toBe(false);
    expect(validateWindowFrom(Infinity)).toBe(false);
    expect(validateWindowFrom('1700000000' as unknown as number)).toBe(false);
  });
});
