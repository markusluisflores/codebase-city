import { describe, expect, it } from 'vitest';
import { githubFileUrl } from '@/lib/links';

const SHA = 'a'.repeat(40);

describe('githubFileUrl', () => {
  it('builds the blob URL at the head sha', () => {
    expect(githubFileUrl({ owner: 'octo', name: 'repo' }, SHA, 'src/a.ts')).toBe(
      `https://github.com/octo/repo/blob/${SHA}/src/a.ts`,
    );
  });

  it('encodes each segment (space, #, ?, unicode) and keeps the slashes', () => {
    const url = githubFileUrl({ owner: 'octo', name: 'repo' }, SHA, 'my dir/a#b?c/é ü.ts');
    expect(url).toBe(
      `https://github.com/octo/repo/blob/${SHA}/my%20dir/a%23b%3Fc/%C3%A9%20%C3%BC.ts`,
    );
  });

  it('keeps a literal % from being read as an escape', () => {
    expect(githubFileUrl({ owner: 'o', name: 'r' }, SHA, '100%/x')).toContain('/100%25/x');
  });
});
