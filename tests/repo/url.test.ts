import { describe, expect, it } from 'vitest';
import { parseRepoInput } from '@/lib/repo/url';

describe('parseRepoInput', () => {
  it.each([
    ['owner/repo', 'owner', 'repo'],
    ['Owner/Repo', 'Owner', 'Repo'],
    ['  owner/repo  ', 'owner', 'repo'],
    ['https://github.com/Owner/Repo.git', 'Owner', 'Repo'],
    ['http://www.github.com/o/r/tree/main', 'o', 'r'],
    ['HTTPS://GITHUB.COM/o/r', 'o', 'r'],
    ['github.com/o/r', 'o', 'r'],
    ['www.github.com/o/r/', 'o', 'r'],
    ['https://github.com/o/r/tree/feature/x-1.2', 'o', 'r'],
    ['o/r.js', 'o', 'r.js'],
    ['o/my.repo.git', 'o', 'my.repo'],
  ])('accepts %s', (input, owner, name) => {
    expect(parseRepoInput(input)).toEqual({ owner, name });
  });

  it.each([
    '',
    '   ',
    'owner/repo;rm -rf',
    'owner/repo; rm -rf /',
    '--upload-pack=x/y',
    'x/--upload-pack=y',
    'https://evil.com/o/r',
    'https://github.com.evil.com/o/r',
    'https://evil.com/github.com/o/r',
    'https://user:pw@github.com/o/r',
    'https://github.com:8443/o/r',
    'ssh://git@github.com/o/r',
    'git@github.com:o/r.git',
    'file:///etc/passwd',
    'github.com/o',
    'https://github.com/o',
    'o',
    './r',
    '../r',
    '././',
    './.',
    'o/.',
    'o/..',
    '../..',
    '-o/r',
    'o/-r',
    '.o/r',
    'o/.r',
    'o/.git',
    'o/r/extra',
    'o/r?x=1',
    'o/r#frag',
    'o/r\nx',
    'o/r\u0000',
    'o /r',
    'o/r name',
    'o/r$(id)',
    'o/r`id`',
    'o/r|id',
    'o/r&id',
    'o/r%2e',
    'öwner/repo',
    'a.b/repo',
    'a_b/repo',
    'o/r/tree/main/../..;x',
    'o/r/tree/',
    'o/r/tree',
    `${'a'.repeat(40)}/r`,
    `o/${'r'.repeat(101)}`,
    'https://github.com//o/r',
  ])('rejects %j', (input) => {
    expect(parseRepoInput(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseRepoInput(undefined as unknown as string)).toBeNull();
    expect(parseRepoInput(42 as unknown as string)).toBeNull();
  });

  it('rejects an over-long input before doing any work', () => {
    expect(parseRepoInput(`o/${'r'.repeat(5000)}`)).toBeNull();
  });
});
