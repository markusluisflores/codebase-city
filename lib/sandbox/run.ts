import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAnalysis } from '../analysis/schema';
import type { Analysis } from '../analysis/types';
import { CAPS } from '../caps';
import {
  validateBranchName,
  validateHeadSha,
  validateOwnerName,
  validateWindowFrom,
} from '../repo/validate';

export const SANDBOX_ERROR_CODES = [
  'timeout',
  'clone_failed',
  'stale_head',
  'invalid_output',
  'too_many_commits_in_window',
  'too_many_files',
  'bad_argument',
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode) {
    super(code); // the message is the code only: no stderr, no repo content
    this.name = 'SandboxError';
  }
}

export type Phase = 'cloning' | 'reading_history' | 'computing';
const PHASES: ReadonlySet<string> = new Set(['cloning', 'reading_history', 'computing']);
const JOB_CODES: ReadonlySet<string> = new Set([
  'bad_argument',
  'too_many_files',
  'clone_failed',
  'stale_head',
  'too_many_commits_in_window',
  'invalid_output',
]);

export interface RunInput {
  owner: string;
  name: string;
  headSha: string;
  defaultBranch: string;
  windowFromUnix: number;
  head: { path: string; size: number }[];
  deadlineMs: number;
  onPhase?: (phase: Phase) => void;
  /**
   * Called (and awaited) once the Sandbox exists, before anything runs in it. From this point the
   * run is billable, so the caller records it (Task 12b: no refund after this). A rejection aborts
   * the run with the Sandbox stopped.
   */
  onSandboxCreated?: () => void | Promise<void>;
}

/** The slice of `@vercel/sandbox` this runner uses, so tests can mock it. */
export interface CommandLike {
  logs(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>;
  wait(): Promise<{ exitCode: number | null }>;
}
export interface SandboxLike {
  writeFiles(files: { path: string; content: Buffer }[]): Promise<void>;
  runCommand(p: { cmd: string; args: string[]; detached: true; cwd: string }): Promise<CommandLike>;
  stop(): Promise<void>;
}
export interface CreateOptions {
  timeout: number;
  networkPolicy: { allow: string[] };
  persistent: false;
  resources: { vcpus: number };
}
export interface RunnerDeps {
  createSandbox?: (opts: CreateOptions) => Promise<SandboxLike>;
  readBundle?: () => Promise<Buffer>;
}

const STOP_BOUND_MS = 5_000;

/** Stops the Sandbox but never waits on a hung stop call for more than a few seconds. */
async function stopBounded(sandbox: SandboxLike): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    sandbox.stop().catch(() => undefined),
    new Promise<void>((resolve) => {
      t = setTimeout(resolve, STOP_BOUND_MS);
    }),
  ]);
  clearTimeout(t);
}

/** The only host the Sandbox may reach. */
export const EGRESS_ALLOW = ['github.com'];
const DIR = '/vercel/sandbox';

async function defaultCreate(opts: CreateOptions): Promise<SandboxLike> {
  const { Sandbox } = await import('@vercel/sandbox');
  return (await Sandbox.create(
    opts as Parameters<typeof Sandbox.create>[0],
  )) as unknown as SandboxLike;
}

const defaultBundle = () => readFile(join(process.cwd(), 'dist', 'sandbox-job.mjs'));

interface Outcome {
  analysis: unknown;
}

/** Reads stdout lines as they arrive; enforces the byte cap while streaming. */
async function consume(cmd: CommandLike, onPhase?: (p: Phase) => void): Promise<Outcome> {
  let total = 0;
  let pending = '';
  let analysis: unknown;
  let sawAnalysis = false;

  const handle = (line: string) => {
    if (line === '') return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new SandboxError('invalid_output');
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new SandboxError('invalid_output');
    }
    const o = obj as Record<string, unknown>;
    if ('schemaVersion' in o) {
      if (sawAnalysis) throw new SandboxError('invalid_output');
      sawAnalysis = true;
      analysis = obj;
    } else if (typeof o.phase === 'string') {
      if (PHASES.has(o.phase)) {
        try {
          onPhase?.(o.phase as Phase);
        } catch {
          // A faulty callback must not fail the analysis.
        }
      }
    } else if (typeof o.error === 'string') {
      throw new SandboxError(
        JOB_CODES.has(o.error) ? (o.error as SandboxErrorCode) : 'invalid_output',
      );
    } else {
      throw new SandboxError('invalid_output');
    }
  };

  for await (const entry of cmd.logs()) {
    if (entry.stream !== 'stdout') continue; // stderr is never read into a result or log
    total += Buffer.byteLength(entry.data, 'utf8');
    if (total > CAPS.maxStdoutBytes) throw new SandboxError('invalid_output');
    pending += entry.data;
    let nl: number;
    while ((nl = pending.indexOf('\n')) !== -1) {
      handle(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  }
  handle(pending);

  const done = await cmd.wait();
  if (!sawAnalysis || done.exitCode !== 0) throw new SandboxError('invalid_output');
  return { analysis };
}

/**
 * Runs the bundled job in a fresh Sandbox whose egress is limited to github.com and whose own
 * timeout equals the deadline, so it cannot outlive a killed web function. Always stops the
 * Sandbox. Every failure is a `SandboxError` carrying only a code.
 */
export async function runAnalysisInSandbox(
  input: RunInput,
  deps: RunnerDeps = {},
): Promise<Analysis> {
  // Defence in depth: the job re-validates, but nothing bad should reach a Sandbox at all.
  if (
    !validateOwnerName(input.owner) ||
    !validateOwnerName(input.name) ||
    !validateHeadSha(input.headSha) ||
    !validateBranchName(input.defaultBranch) ||
    !validateWindowFrom(input.windowFromUnix) ||
    !Number.isInteger(input.deadlineMs) ||
    input.deadlineMs <= 0
  ) {
    throw new SandboxError('bad_argument');
  }
  if (input.head.length > CAPS.maxFiles) throw new SandboxError('too_many_files');

  const create = deps.createSandbox ?? defaultCreate;
  const readBundle = deps.readBundle ?? defaultBundle;

  const startedAt = Date.now();
  let aborted = false;
  let sandbox: SandboxLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxError('timeout')), input.deadlineMs);
  });

  const work = (async (): Promise<Outcome> => {
    const bundle = await readBundle();
    if (aborted) throw new SandboxError('timeout'); // never start creating after the deadline
    sandbox = await create({
      timeout: input.deadlineMs,
      networkPolicy: { allow: EGRESS_ALLOW },
      persistent: false,
      resources: { vcpus: 2 },
    });
    // The Sandbox exists and is billable from here, even if the deadline already won.
    await input.onSandboxCreated?.();
    if (aborted) {
      // The deadline (or an error) won while the Sandbox was being created.
      await stopBounded(sandbox);
      throw new SandboxError('timeout');
    }
    await sandbox.writeFiles([
      { path: `${DIR}/job.mjs`, content: bundle },
      { path: `${DIR}/sizes.json`, content: Buffer.from(JSON.stringify(input.head), 'utf8') },
    ]);
    const cmd = await sandbox.runCommand({
      cmd: 'node',
      args: [
        `${DIR}/job.mjs`,
        '--',
        input.owner,
        input.name,
        input.headSha,
        input.defaultBranch,
        String(input.windowFromUnix),
        `${DIR}/sizes.json`,
      ],
      detached: true,
      cwd: DIR,
    });
    return consume(cmd, input.onPhase);
  })();
  work.catch(() => undefined); // losing the race below must not become an unhandled rejection

  try {
    const outcome = await Promise.race([work, deadline]);
    let analysis: Analysis;
    try {
      analysis = parseAnalysis(outcome.analysis);
    } catch {
      throw new SandboxError('invalid_output');
    }
    if (
      analysis.repo.owner !== input.owner ||
      analysis.repo.name !== input.name ||
      analysis.repo.headSha !== input.headSha
    ) {
      throw new SandboxError('invalid_output');
    }
    return analysis;
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    // The SDK rejects when the Sandbox's own timeout stops a running command; anything else
    // (network, API) is reported as a clone failure without its message.
    throw new SandboxError(
      Date.now() - startedAt >= input.deadlineMs - 1000 ? 'timeout' : 'clone_failed',
    );
  } finally {
    clearTimeout(timer);
    aborted = true;
    if (sandbox) await stopBounded(sandbox);
  }
}
