import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { gitLogRaw, makeRepo } from './makeRepo';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function repoOf(commits: Parameters<typeof makeRepo>[0]) {
  const repo = await makeRepo(commits);
  cleanups.push(repo.cleanup);
  return repo;
}

/** Paths of every record: after the header's NUL comes one newline, then NUL-terminated paths. */
function pathsOf(raw: string): string[] {
  return raw
    .split('\x1e')
    .filter(Boolean)
    .flatMap((rec) =>
      rec
        .slice(rec.indexOf('\0\n') + 2)
        .split('\0')
        .filter(Boolean),
    );
}

const base = 1_700_000_000;
const c = (n: number, files: Record<string, string>, extra = {}) => ({
  author: `Author ${n}`,
  email: `author${n}@example.com`,
  time: base + n * 86_400,
  subject: `commit ${n}`,
  files,
  ...extra,
});

describe('makeRepo / gitLogRaw', () => {
  it('builds a repo whose log contains every subject and path', async () => {
    const { dir } = await repoOf([
      c(1, { 'a.txt': 'a' }),
      c(2, { 'b.txt': 'b' }),
      c(3, { 'src/c.ts': 'c' }),
    ]);
    const raw = gitLogRaw(dir);
    for (const s of ['commit 1', 'commit 2', 'commit 3', 'a.txt', 'b.txt', 'src/c.ts']) {
      expect(raw).toContain(s);
    }
    expect(raw).toContain('author1@example.com');
  });

  it('round-trips paths with a space, quote and unicode character', async () => {
    const path = 'dir with space/we"ird é日本.txt';
    const { dir } = await repoOf([c(1, { [path]: 'x' })]);
    expect(pathsOf(gitLogRaw(dir))).toContain(path);
  });

  it('round-trips a path containing a double quote and a newline without a working-tree file', async () => {
    const path = 'bad"na\nme.txt';
    const { dir } = await repoOf([c(1, { [path]: 'x' })]);
    expect(pathsOf(gitLogRaw(dir))).toContain(path);
    expect(existsSync(`${dir}/${path}`)).toBe(false);
  });

  it('round-trips a path containing a tab', async () => {
    const path = 'a\tb.txt';
    const { dir } = await repoOf([c(1, { [path]: 'x' })]);
    expect(pathsOf(gitLogRaw(dir))).toContain(path);
  });

  it('sets author and committer timestamps to the scripted time', async () => {
    const { dir } = await repoOf([c(1, { 'a.txt': 'a' })]);
    const out = execFileSync('git', ['log', '--format=%at %ct %an %ae %cn %ce'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(out).toBe(
      `${base + 86_400} ${base + 86_400} Author 1 author1@example.com Author 1 author1@example.com`,
    );
  });

  it('is deterministic: identical input gives identical commit hashes', async () => {
    const input = [c(1, { 'a.txt': 'a' }), c(2, { 'a.txt': 'b' })];
    const a = await repoOf(input);
    const b = await repoOf(input);
    const head = (d: string) =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' });
    expect(head(a.dir)).toBe(head(b.dir));
  });

  it('lists only the files each commit changed', async () => {
    const { dir } = await repoOf([c(1, { 'a.txt': 'a', 'b.txt': 'b' }), c(2, { 'a.txt': 'a2' })]);
    const raw = gitLogRaw(dir);
    const [newest, oldest] = raw.split('\x1e').filter(Boolean);
    expect(newest).toContain('a.txt');
    expect(newest).not.toContain('b.txt');
    expect(oldest).toContain('b.txt');
  });

  it('is not affected by autocrlf: file content is stored byte-for-byte', async () => {
    const { dir } = await repoOf([c(1, { 'crlf.txt': 'one\r\ntwo\r\n' })]);
    const size = execFileSync('git', ['cat-file', '-s', 'HEAD:crlf.txt'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(size.trim()).toBe('10');
  });

  it('points core.hooksPath at an empty directory so no hook can run', async () => {
    const { dir } = await repoOf([c(1, { 'a.txt': 'a' })]);
    const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(readdirSync(hooksPath)).toEqual([]);
  });

  it('limits history to commits at or after sinceUnix', async () => {
    const { dir } = await repoOf([
      c(1, { 'a.txt': 'a' }),
      c(2, { 'b.txt': 'b' }),
      c(3, { 'c.txt': 'c' }),
    ]);
    const raw = gitLogRaw(dir, base + 2 * 86_400);
    expect(raw).toContain('commit 2');
    expect(raw).toContain('commit 3');
    expect(raw).not.toContain('commit 1');
  });

  it('cleanup removes the directory', async () => {
    const repo = await makeRepo([c(1, { 'a.txt': 'a' })]);
    await repo.cleanup();
    expect(existsSync(repo.dir)).toBe(false);
  });

  it('supports an empty commit list as an empty repo', async () => {
    const { dir } = await repoOf([]);
    expect(gitLogRaw(dir)).toBe('');
  });
});
