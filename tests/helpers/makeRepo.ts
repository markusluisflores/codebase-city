import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ScriptedCommit = {
  author: string;
  email: string;
  /** Unix seconds; used for both author and committer dates. */
  time: number;
  subject: string;
  /** Path -> content, for the files this commit adds or changes. */
  files: Record<string, string>;
};

/**
 * Environment that isolates git from the machine: no system or global config
 * (so no autocrlf, signing, hooks path or templates), and no GIT_* variables
 * inherited from a parent git process such as a commit hook.
 */
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_')) delete env[k];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    // git for Windows maps /dev/null itself; it rejects os.devNull on Windows.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C', // untranslated git messages (empty-repo detection) and stable output
    ...extra,
  };
}

function git(
  dir: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): string {
  return execFileSync('git', args, {
    cwd: dir,
    input: opts.input,
    env: isolatedEnv(opts.env),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Builds a real local git repo from scripted commits using plumbing only
 * (hash-object, update-index, write-tree, commit-tree, update-ref), so no
 * working-tree file is ever written and paths that are illegal on Windows
 * (a double quote, a newline) still work. Output is deterministic.
 */
export async function makeRepo(
  commits: ScriptedCommit[],
): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'codebase-city-fixture-'));
  const emptyHooks = join(dir, '.git-empty-hooks');
  mkdirSync(emptyHooks);

  try {
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    git(dir, ['config', 'core.hooksPath', emptyHooks]);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    // Windows git otherwise refuses index paths with a quote, tab or newline.
    git(dir, ['config', 'core.protectNTFS', 'false']);

    let parent: string | null = null as string | null;
    for (const commit of commits) {
      for (const [path, content] of Object.entries(commit.files)) {
        const blob = git(dir, ['hash-object', '-w', '--stdin'], { input: content }).trim();
        git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
      }
      const tree = git(dir, ['write-tree']).trim();
      const date = `${commit.time} +0000`;
      const args: string[] = [
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        commit.subject,
      ];
      parent = git(dir, args, {
        env: {
          GIT_AUTHOR_NAME: commit.author,
          GIT_AUTHOR_EMAIL: commit.email,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: commit.author,
          GIT_COMMITTER_EMAIL: commit.email,
          GIT_COMMITTER_DATE: date,
        },
      }).trim();
      git(dir, ['update-ref', 'refs/heads/main', parent]);
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The spec section 7 history command plus `-z`: NUL-separated output so any
 * path survives. Each record starts with U+001E (RS); its header fields
 * (hash, author name, author email, unix time, subject) are separated by
 * U+001F and end with a NUL; a single newline follows, then the changed paths,
 * each NUL-terminated. The spec's `-c mailmap.blob=... --use-mailmap` flags are
 * deliberately omitted here; the sandbox job (Task 9) owns mailmap coverage.
 */
export function gitLogRaw(dir: string, sinceUnix?: number): string {
  const args = [
    'log',
    '--no-merges',
    '--no-renames',
    '--name-only',
    '-z',
    '--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s',
  ];
  if (sinceUnix !== undefined) args.push(`--since=${sinceUnix}`);
  try {
    return git(dir, args);
  } catch (e) {
    // An empty repo (no commits) makes `git log` fail; that is an empty history.
    if (/does not have any commits/.test(String((e as { stderr?: string }).stderr))) return '';
    throw e;
  }
}
