import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '@/lib/analysis/schema';
import { analyze } from '@/lib/ingest/analyze';
import { CAPS } from '@/lib/caps';
import {
  EGRESS_ALLOW,
  runAnalysisInSandbox,
  SandboxError,
  type CommandLike,
  type CreateOptions,
  type Phase,
  type RunInput,
  type SandboxLike,
} from '@/lib/sandbox/run';

const SHA = 'a'.repeat(40);
const base = (over: Partial<RunInput> = {}): RunInput => ({
  owner: 'octo',
  name: 'demo',
  headSha: SHA,
  defaultBranch: 'main',
  windowFromUnix: 1_690_000_000,
  head: [{ path: 'a.ts', size: 1 }],
  deadlineMs: 5_000,
  ...over,
});
const analysisFor = (i: RunInput) =>
  analyze({
    repo: { owner: i.owner, name: i.name, headSha: i.headSha, defaultBranch: i.defaultBranch },
    rawLog: '',
    head: i.head,
    windowFromUnix: i.windowFromUnix,
  });

interface Mock {
  sandbox: SandboxLike;
  stop: ReturnType<typeof vi.fn>;
  created: CreateOptions[];
  commands: { cmd: string; args: string[] }[];
  create: (o: CreateOptions) => Promise<SandboxLike>;
}

function mock(
  chunks: () => AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>,
  exitCode: number | null = 0,
): Mock {
  const stop = vi.fn(async () => undefined);
  const commands: Mock['commands'] = [];
  const sandbox: SandboxLike = {
    writeFiles: async () => undefined,
    runCommand: async (p) => {
      commands.push({ cmd: p.cmd, args: p.args });
      const c: CommandLike = { logs: chunks, wait: async () => ({ exitCode }) };
      return c;
    },
    stop,
  };
  const created: CreateOptions[] = [];
  return {
    sandbox,
    stop,
    created,
    commands,
    create: async (o) => {
      created.push(o);
      return sandbox;
    },
  };
}

async function* lines(...ls: string[]) {
  for (const l of ls) yield { stream: 'stdout' as const, data: l };
}
const deps = (m: Mock) => ({
  createSandbox: m.create,
  readBundle: async () => Buffer.from('//job'),
});
const phases = ['cloning', 'reading_history', 'computing'].map((p) => `{"phase":"${p}"}\n`);

describe('runAnalysisInSandbox', () => {
  it('creates the Sandbox with timeout = deadline and github.com-only egress, passes args after --', async () => {
    const input = base();
    const m = mock(() => lines(...phases, JSON.stringify(analysisFor(input)) + '\n'));
    const seen: Phase[] = [];
    const a = await runAnalysisInSandbox({ ...input, onPhase: (p) => seen.push(p) }, deps(m));
    expect(a.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.created[0]).toMatchObject({ timeout: 5_000, persistent: false });
    expect(m.created[0]!.networkPolicy.allow).toEqual(['github.com']);
    expect(EGRESS_ALLOW).toEqual(['github.com']);
    expect(seen).toEqual(['cloning', 'reading_history', 'computing']);
    const args = m.commands[0]!.args;
    expect(m.commands[0]!.cmd).toBe('node');
    expect(args.slice(1)).toEqual([
      '--',
      'octo',
      'demo',
      SHA,
      'main',
      '1690000000',
      '/vercel/sandbox/sizes.json',
    ]);
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  it('handles lines split across chunks', async () => {
    const input = base();
    const text = phases.join('') + JSON.stringify(analysisFor(input)) + '\n';
    const m = mock(() => lines(text.slice(0, 10), text.slice(10, 90), text.slice(90)));
    await expect(runAnalysisInSandbox(input, deps(m))).resolves.toBeDefined();
  });

  it('invalid JSON raises invalid_output and still destroys the Sandbox', async () => {
    const m = mock(() => lines('not json\n'));
    await expect(runAnalysisInSandbox(base(), deps(m))).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'name', 'headSha'] as const)(
    'a returned repo.%s that differs raises invalid_output',
    async (k) => {
      const input = base();
      const a = analysisFor(input);
      a.repo = { ...a.repo, [k]: k === 'headSha' ? 'b'.repeat(40) : 'other' };
      const m = mock(() => lines(JSON.stringify(a) + '\n'));
      await expect(runAnalysisInSandbox(input, deps(m))).rejects.toMatchObject({
        code: 'invalid_output',
      });
      expect(m.stop).toHaveBeenCalled();
    },
  );

  it('an Analysis that fails the schema raises invalid_output', async () => {
    const m = mock(() => lines(JSON.stringify({ schemaVersion: SCHEMA_VERSION, repo: {} }) + '\n'));
    await expect(runAnalysisInSandbox(base(), deps(m))).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('stdout over the 8 MB cap raises invalid_output and destroys the Sandbox', async () => {
    const big = 'x'.repeat(1_048_576);
    const m = mock(async function* () {
      for (let i = 0; i < 9; i++) yield { stream: 'stdout' as const, data: big };
    });
    await expect(runAnalysisInSandbox(base(), deps(m))).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  it('ignores stderr: it is never read and never counts towards the stdout cap', async () => {
    const input = base();
    const m = mock(async function* () {
      yield { stream: 'stderr' as const, data: 'y'.repeat(CAPS.maxStdoutBytes + 10) };
      yield { stream: 'stdout' as const, data: JSON.stringify(analysisFor(input)) + '\n' };
    });
    await expect(runAnalysisInSandbox(input, deps(m))).resolves.toBeDefined();
  });

  it('accepts stdout of exactly the cap and rejects one byte more', async () => {
    const input = base();
    const line = JSON.stringify(analysisFor(input)) + '\n';
    const pad = (n: number) => '\n'.repeat(n); // empty lines are skipped but counted
    const exact = line + pad(CAPS.maxStdoutBytes - Buffer.byteLength(line));
    expect(Buffer.byteLength(exact)).toBe(CAPS.maxStdoutBytes);
    await expect(
      runAnalysisInSandbox(input, deps(mock(() => lines(exact)))),
    ).resolves.toBeDefined();
    await expect(
      runAnalysisInSandbox(input, deps(mock(() => lines(exact + '\n')))),
    ).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('raises timeout at the deadline and destroys the Sandbox', async () => {
    const m = mock(async function* () {
      await new Promise(() => undefined); // never ends
      yield { stream: 'stdout' as const, data: '' };
    });
    await expect(runAnalysisInSandbox(base({ deadlineMs: 40 }), deps(m))).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  it('stops a Sandbox that finishes creating after the deadline', async () => {
    const stop = vi.fn(async () => undefined);
    const late = async () => {
      await new Promise((r) => setTimeout(r, 80));
      return {
        writeFiles: async () => undefined,
        runCommand: async () => ({}) as CommandLike,
        stop,
      } as SandboxLike;
    };
    await expect(
      runAnalysisInSandbox(base({ deadlineMs: 20 }), {
        createSandbox: late,
        readBundle: async () => Buffer.from(''),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await new Promise((r) => setTimeout(r, 150));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each(['clone_failed', 'stale_head', 'too_many_commits_in_window', 'too_many_files'])(
    'maps the job error %s to a SandboxError with that code',
    async (code) => {
      const m = mock(() => lines(phases[0]!, `{"error":"${code}"}\n`), 1);
      await expect(runAnalysisInSandbox(base(), deps(m))).rejects.toMatchObject({ code });
      expect(m.stop).toHaveBeenCalled();
    },
  );

  it('maps an unknown error code, a non-zero exit and an empty stream to invalid_output', async () => {
    for (const m of [
      mock(() => lines('{"error":"<script>"}\n'), 1),
      mock(() => lines(...phases), 1),
      mock(() => lines(), 0),
    ]) {
      await expect(runAnalysisInSandbox(base(), deps(m))).rejects.toMatchObject({
        code: 'invalid_output',
      });
    }
  });

  it('rejects a second Analysis line and an object that is neither phase nor error', async () => {
    const input = base();
    const line = JSON.stringify(analysisFor(input)) + '\n';
    await expect(
      runAnalysisInSandbox(input, deps(mock(() => lines(line, line)))),
    ).rejects.toMatchObject({
      code: 'invalid_output',
    });
    await expect(
      runAnalysisInSandbox(input, deps(mock(() => lines('{"x":1}\n')))),
    ).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('errors carry only a code, never SDK or stderr text', async () => {
    const m = mock(() => lines());
    m.sandbox.writeFiles = async () => {
      throw new Error('secret token abc at /home/x');
    };
    const e = await runAnalysisInSandbox(base(), deps(m)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxError);
    expect(String((e as Error).message)).toBe('clone_failed');
    expect(m.stop).toHaveBeenCalled();
  });

  it('rejects bad inputs before creating a Sandbox', async () => {
    const m = mock(() => lines());
    const create = vi.fn(m.create);
    for (const bad of [
      base({ owner: '-x' }),
      base({ name: 'a;b' }),
      base({ headSha: 'abc' }),
      base({ windowFromUnix: 5 }),
      base({ windowFromUnix: 1.5 }),
      base({ defaultBranch: '--x' }),
      base({ deadlineMs: 0 }),
      base({
        head: Array.from({ length: CAPS.maxFiles + 1 }, (_, i) => ({ path: `f${i}`, size: 1 })),
      }),
    ]) {
      await expect(runAnalysisInSandbox(bad, { createSandbox: create })).rejects.toBeInstanceOf(
        SandboxError,
      );
    }
    expect(create).not.toHaveBeenCalled();
  });
});
