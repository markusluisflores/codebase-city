import { afterEach, describe, expect, it } from 'vitest';
import { gitLogRaw, makeRepo } from '../helpers/makeRepo';
import { parseLog, type Commit } from '../../lib/ingest/parseLog';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function log(commits: Parameters<typeof makeRepo>[0]) {
  const repo = await makeRepo(commits);
  cleanups.push(repo.cleanup);
  return gitLogRaw(repo.dir);
}

/** Commit at an index, failing the test (not the type checker) when absent. */
function at(commits: Commit[], i: number): Commit {
  const c = commits[i];
  if (!c) throw new Error(`no commit at index ${i}`);
  return c;
}

const ANN = 'ann@example.test';

describe('parseLog', () => {
  it('returns [] for an empty string', () => {
    expect(parseLog('')).toEqual([]);
  });

  it('parses commits newest first with header fields and files', async () => {
    const raw = await log([
      { author: 'Ann', email: ANN, time: 1700000010, subject: 'first', files: { 'a.txt': '1' } },
      {
        author: 'Bob',
        email: 'bob@example.test',
        time: 1700000020,
        subject: 'second: fix thing',
        files: { 'a.txt': '2', 'src/b.ts': 'x' },
      },
    ]);
    const commits = parseLog(raw);
    expect(commits).toHaveLength(2);
    expect(at(commits, 0)).toMatchObject({
      authorName: 'Bob',
      authorEmail: 'bob@example.test',
      time: 1700000020,
      subject: 'second: fix thing',
    });
    expect(at(commits, 0).hash).toMatch(/^[0-9a-f]{40}$/);
    expect([...at(commits, 0).files].sort()).toEqual(['a.txt', 'src/b.ts']);
    expect(at(commits, 1).files).toEqual(['a.txt']);
  });

  it('keeps awkward paths exact: space, quote, unicode, tab, newline', async () => {
    const paths = [
      'with space.txt',
      'say "hi".txt',
      'naïve/日本語.md',
      'tab\there.txt',
      'new\nline.txt',
    ];
    const raw = await log([
      {
        author: 'Ann',
        email: ANN,
        time: 1700000010,
        subject: 'odd',
        files: Object.fromEntries(paths.map((p) => [p, 'x'])),
      },
    ]);
    expect([...at(parseLog(raw), 0).files].sort()).toEqual([...paths].sort());
  });

  it('returns files: [] for a commit with no files, between commits that have files', async () => {
    const raw = await log([
      { author: 'Ann', email: ANN, time: 1700000010, subject: 'one', files: { 'a.txt': '1' } },
      { author: 'Ann', email: ANN, time: 1700000020, subject: 'empty', files: {} },
      { author: 'Ann', email: ANN, time: 1700000030, subject: 'three', files: { 'c.txt': '1' } },
    ]);
    const commits = parseLog(raw);
    expect(commits.map((c) => c.subject)).toEqual(['three', 'empty', 'one']);
    expect(at(commits, 0).files).toEqual(['c.txt']);
    expect(at(commits, 1).files).toEqual([]);
    expect(at(commits, 2).files).toEqual(['a.txt']);
  });

  it('drops commits whose hash is in dropHashes', async () => {
    const raw = await log([
      { author: 'Ann', email: ANN, time: 1700000010, subject: 'old', files: { 'a.txt': '1' } },
      { author: 'Ann', email: ANN, time: 1700000020, subject: 'new', files: { 'b.txt': '1' } },
    ]);
    const all = parseLog(raw);
    const kept = parseLog(raw, { dropHashes: new Set([at(all, 1).hash]) });
    expect(kept.map((c) => c.subject)).toEqual(['new']);
  });

  it('keeps empty author name and email as empty strings', () => {
    // git commit-tree refuses an empty ident, so imported history is simulated with a literal record.
    const hash = 'd'.repeat(40);
    const raw = `\x1e${hash}\x1f\x1f\x1f1700000010\x1fanon\0\na.txt\0`;
    const c = at(parseLog(raw), 0);
    expect(c.authorName).toBe('');
    expect(c.authorEmail).toBe('');
    expect(c.files).toEqual(['a.txt']);
  });

  it('keeps a unit separator inside a subject', () => {
    const hash = 'a'.repeat(40);
    const raw = `\x1e${hash}\x1fAnn\x1fa@x.test\x1f5\x1fhello\x1fworld\0\nf.txt\0`;
    const c = at(parseLog(raw), 0);
    expect(c.subject).toBe('hello\x1fworld');
    expect(c.files).toEqual(['f.txt']);
  });

  it('does not split a record on a path that starts with the record separator', () => {
    const h1 = 'a'.repeat(40);
    const h2 = 'b'.repeat(40);
    const raw =
      `\x1e${h1}\x1fAnn\x1fa@x.test\x1f5\x1fone\0\n\x1estart.txt\0ok.txt\0` +
      `\x1e${h2}\x1fBob\x1fb@x.test\x1f6\x1ftwo\0\nz.txt\0`;
    const commits = parseLog(raw);
    expect(commits.map((c) => c.hash)).toEqual([h1, h2]);
    expect(at(commits, 0).files).toEqual(['\x1estart.txt', 'ok.txt']);
  });

  it('skips a malformed record instead of throwing', () => {
    const hash = 'c'.repeat(40);
    const raw = `\x1e${hash}\x1fAnn\x1fa@x.test\x1fnotanumber\x1fbad\0\nf.txt\0`;
    expect(parseLog(raw)).toEqual([]);
  });

  it('keeps bot and unicode author names verbatim', async () => {
    const raw = await log([
      {
        author: 'dependabot[bot]',
        email: '1+dependabot[bot]@users.noreply.github.test',
        time: 1700000010,
        subject: 'bump',
        files: { 'package.json': '{}' },
      },
      {
        author: 'Zoë 山田',
        email: 'z@example.test',
        time: 1700000020,
        subject: 'hi',
        files: { x: '1' },
      },
    ]);
    expect(parseLog(raw).map((c) => c.authorName)).toEqual(['Zoë 山田', 'dependabot[bot]']);
  });
});
