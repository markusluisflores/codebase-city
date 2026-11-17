import { vi } from 'vitest';
import type { Analysis } from '@/lib/analysis/types';
import { analyze } from '@/lib/ingest/analyze';
import type { RepoFacts } from '@/lib/repo/github';
import type {
  CommandLike,
  CreateOptions,
  RunInput,
  RunnerDeps,
  SandboxLike,
} from '@/lib/sandbox/run';
import { createSessionToken, SESSION_COOKIE } from '@/lib/session';

// Obviously fake values, created here.
export const PASSWORD = 'fake-demo-password-for-tests';
export const SECRET = 'fake-session-secret-for-tests-0123456789';
export const SHA = 'a'.repeat(40);
export const SHA2 = 'b'.repeat(40);

export function stubSessionEnv(): void {
  vi.stubEnv('DEMO_PASSWORD', PASSWORD);
  vi.stubEnv('SESSION_SECRET', SECRET);
}

export async function cookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await createSessionToken(SECRET)}`;
}

export function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    owner: 'Octo',
    name: 'Repo',
    sizeKb: 1000,
    totalCommits: 100,
    latestCommitUnix: 1_700_000_000,
    windowFromUnix: 1_636_000_000,
    headSha: SHA,
    defaultBranch: 'main',
    tree: [{ path: 'src/a.ts', size: 10 }],
    treeTruncated: false,
    ...over,
  };
}

export function analysisFor(i: {
  owner: string;
  name: string;
  headSha: string;
  defaultBranch: string;
  windowFromUnix: number;
  head: { path: string; size: number }[];
}): Analysis {
  return analyze({
    repo: { owner: i.owner, name: i.name, headSha: i.headSha, defaultBranch: i.defaultBranch },
    rawLog: '',
    head: i.head,
    windowFromUnix: i.windowFromUnix,
  });
}

type Chunk = { stream: 'stdout' | 'stderr'; data: string };

export interface FakeSandbox {
  deps: RunnerDeps;
  created: CreateOptions[];
  stop: ReturnType<typeof vi.fn>;
  runs: number;
}

/**
 * A mock Sandbox whose command prints the given phase lines then the analysis (or `script`'s output).
 * `script(args, input)` may yield custom chunks; `beforeOutput` runs when the command starts.
 */
export function fakeSandbox(
  opts: {
    script?: (analysis: Analysis) => AsyncIterable<Chunk>;
    createFails?: boolean;
    bundleFails?: boolean;
    beforeOutput?: () => Promise<void> | void;
    exitCode?: number | null;
  } = {},
): FakeSandbox {
  const state: FakeSandbox = { created: [], stop: vi.fn(async () => undefined), runs: 0, deps: {} };
  state.deps = {
    readBundle: async () => {
      if (opts.bundleFails) throw new Error('ENOENT /var/task/dist/sandbox-job.mjs');
      return Buffer.from('//job');
    },
    createSandbox: async (o) => {
      if (opts.createFails) throw new Error('create failed: token=SECRET-TOKEN');
      state.created.push(o);
      const sandbox: SandboxLike = {
        writeFiles: async () => undefined,
        runCommand: async (p) => {
          state.runs++;
          await opts.beforeOutput?.();
          const [, , owner, name, headSha, defaultBranch, from] = p.args as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ];
          const analysis = analysisFor({
            owner: owner!,
            name: name!,
            headSha: headSha!,
            defaultBranch: defaultBranch!,
            windowFromUnix: Number(from),
            head: [{ path: 'src/a.ts', size: 10 }],
          });
          const logs =
            opts.script?.(analysis) ??
            (async function* () {
              for (const ph of ['cloning', 'reading_history', 'computing'])
                yield { stream: 'stdout' as const, data: `{"phase":"${ph}"}\n` };
              yield { stream: 'stdout' as const, data: `${JSON.stringify(analysis)}\n` };
            })();
          const cmd: CommandLike = {
            logs: () => logs,
            wait: async () => ({ exitCode: opts.exitCode === undefined ? 0 : opts.exitCode }),
          };
          return cmd;
        },
        stop: state.stop as unknown as () => Promise<void>,
      };
      return sandbox;
    },
  };
  return state;
}

export type { RunInput };
