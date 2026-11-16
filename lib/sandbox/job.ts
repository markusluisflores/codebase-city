// Bundled into one file (`npm run build:sandbox`) and run inside a disposable Vercel Sandbox.
// Untrusted repo content is only ever read through `git log`: nothing is checked out,
// installed or executed. Arguments reach git as an argv array, never through a shell.
// stdout carries JSON lines only: `{"phase":...}`, then one Analysis line or `{"error":code}`.
// stderr, raw git output and commit subjects are never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPS, MAX_ANALYSIS_BYTES } from '../caps';
import { analyze } from '../ingest/analyze';
import { GIT_LOG_ARGS } from '../ingest/parseLog';
import {
  validateBranchName,
  validateHeadSha,
  validateOwnerName,
  validateWindowFrom,
} from '../repo/validate';

export type JobErrorCode =
  | 'bad_argument'
  | 'too_many_files'
  | 'clone_failed'
  | 'stale_head'
  | 'too_many_commits_in_window'
  | 'invalid_output'
  | 'internal_error';

class JobError extends Error {
  constructor(readonly code: JobErrorCode) {
    super(code);
  }
}

export type Exec = (
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => string;

export interface JobDeps {
  exec?: Exec;
  /** Clone URL for a validated owner and name. Tests point it at a local fixture. */
  urlFor?: (owner: string, name: string) => string;
  /** Extra leading `-c` pairs (tests only, to allow the `file` protocol). */
  extraGitConfig?: string[];
  caps?: { maxCommitsInWindow: number; maxFiles: number };
  write?: (line: string) => void;
}

/** Disable hooks, fsmonitor, askpass, credential helpers and every transport except https. */
export const HARDENING_CONFIG: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'credential.helper=',
  '-c',
  'core.askPass=',
  '-c',
  'gc.auto=0',
];

export function cloneUrl(owner: string, name: string): string {
  if (!validateOwnerName(owner) || !validateOwnerName(name)) throw new JobError('bad_argument');
  return `https://github.com/${owner}/${name}.git`;
}

/** The clone argv. Only the validated URL and a temp directory follow `--`. */
export function cloneArgs(
  url: string,
  dir: string,
  windowFromUnix: number,
  extraConfig: string[] = [],
): string[] {
  return [
    ...HARDENING_CONFIG,
    ...extraConfig,
    'clone',
    '--filter=blob:none',
    '--no-checkout',
    '--no-tags',
    '--single-branch',
    `--shallow-since=${windowFromUnix}`,
    '--',
    url,
    dir,
  ];
}

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_')) delete env[k];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...extra,
  };
}

const defaultExec: Exec = (args, opts = {}) =>
  execFileSync('git', args, {
    cwd: opts.cwd,
    env: gitEnv(opts.env),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    // stderr is captured and dropped: it can echo repo content or tokens.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function parseSizes(path: string, maxFiles: number): { path: string; size: number }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new JobError('bad_argument');
  }
  if (!Array.isArray(parsed)) throw new JobError('bad_argument');
  if (parsed.length > maxFiles) throw new JobError('too_many_files');
  for (const f of parsed) {
    if (
      typeof f !== 'object' ||
      f === null ||
      typeof (f as { path?: unknown }).path !== 'string' ||
      !Number.isInteger((f as { size?: unknown }).size) ||
      (f as { size: number }).size < 0
    ) {
      throw new JobError('bad_argument');
    }
  }
  return (parsed as { path: string; size: number }[]).map((f) => ({ path: f.path, size: f.size }));
}

/**
 * argv (after node and the script): `-- owner name headSha defaultBranch windowFromUnix sizesFile`.
 * Returns the process exit code; prints JSON lines through `deps.write`.
 */
export async function runJob(argv: string[], deps: JobDeps = {}): Promise<number> {
  const exec = deps.exec ?? defaultExec;
  const urlFor = deps.urlFor ?? cloneUrl;
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  const caps = deps.caps ?? CAPS;
  const emit = (obj: unknown) => write(`${JSON.stringify(obj)}\n`);
  let workDir: string | undefined;

  try {
    if (argv.length !== 7 || argv[0] !== '--') throw new JobError('bad_argument');
    const [, owner, name, headSha, defaultBranch, windowText, sizesPath] = argv as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const windowFromUnix = /^\d{1,12}$/.test(windowText) ? Number(windowText) : NaN;
    if (
      !validateOwnerName(owner) ||
      !validateOwnerName(name) ||
      !validateHeadSha(headSha) ||
      !validateBranchName(defaultBranch) ||
      !validateWindowFrom(windowFromUnix)
    ) {
      throw new JobError('bad_argument');
    }
    const head = parseSizes(sizesPath, caps.maxFiles);

    workDir = mkdtempSync(join(tmpdir(), 'cc-job-'));
    const repoDir = join(workDir, 'repo');
    const extra = deps.extraGitConfig ?? [];
    const inRepo = (args: string[], env?: Record<string, string>) =>
      exec([...HARDENING_CONFIG, ...extra, ...args], { cwd: repoDir, env });

    emit({ phase: 'cloning' });
    try {
      exec(cloneArgs(urlFor(owner, name), repoDir, windowFromUnix, extra), { cwd: workDir });
    } catch {
      throw new JobError('clone_failed');
    }

    // GIT_NO_LAZY_FETCH: a missing commit must fail, not trigger a fetch.
    try {
      inRepo(['cat-file', '-e', `${headSha}^{commit}`], { GIT_NO_LAZY_FETCH: '1' });
    } catch {
      throw new JobError('stale_head');
    }

    emit({ phase: 'reading_history' });
    const since = `--since=${windowFromUnix}`;
    let count: number;
    try {
      count = Number(inRepo(['rev-list', '--count', '--no-merges', since, headSha, '--']).trim());
    } catch {
      throw new JobError('clone_failed');
    }
    if (!Number.isInteger(count)) throw new JobError('clone_failed');
    if (count > caps.maxCommitsInWindow) throw new JobError('too_many_commits_in_window');

    let mailmapApplied = false;
    try {
      inRepo(['cat-file', '-e', `${headSha}:.mailmap`]);
      mailmapApplied = true;
    } catch {
      // No .mailmap at that commit.
    }

    const [sub, ...rest] = GIT_LOG_ARGS as string[];
    let rawLog: string;
    try {
      rawLog = inRepo([
        '-c',
        `mailmap.blob=${headSha}:.mailmap`,
        sub!,
        ...rest,
        '--use-mailmap',
        since,
        headSha,
        '--',
      ]);
    } catch {
      throw new JobError('clone_failed');
    }

    // A shallow clone's boundary commits list every file as added; drop them (spike item f).
    const shallowFile = join(repoDir, '.git', 'shallow');
    const dropHashes = new Set(
      existsSync(shallowFile)
        ? readFileSync(shallowFile, 'utf8')
            .split('\n')
            .filter((l) => /^[0-9a-f]{40}$/.test(l))
        : [],
    );

    emit({ phase: 'computing' });
    const analysis = analyze({
      repo: { owner, name, headSha, defaultBranch },
      rawLog,
      head,
      dropHashes,
      windowFromUnix,
      mailmapApplied,
    });
    const line = `${JSON.stringify(analysis)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_ANALYSIS_BYTES) throw new JobError('invalid_output');
    write(line);
    return 0;
  } catch (e) {
    emit({ error: e instanceof JobError ? e.code : 'internal_error' });
    return 1;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runJob(process.argv.slice(2)).then((code) => {
    // Not process.exit(): let a large stdout write drain first.
    process.exitCode = code;
  });
}
