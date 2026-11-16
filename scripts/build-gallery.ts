/* eslint-disable no-console -- CLI script: prints repo names and error codes only */
// Gallery build: for each curated repo, run the same pre-checks as the live path
// (`fetchRepoFacts`, `checkCaps`), analyse it locally with the same job the Sandbox runs
// (`runJob`: blobless clone into a temp directory, nothing checked out), validate the result
// and write `public/gallery/<owner>__<repo>.json`.
// Run with `npm run build:gallery` (needs the network; `GITHUB_TOKEN` is optional and read
// from the environment only). Output carries repo names and error codes only.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPS } from '../lib/caps';
import { parseAnalysis } from '../lib/analysis/schema';
import type { Analysis } from '../lib/analysis/types';
import { checkCaps, fetchRepoFacts, GitHubError, type RepoFacts } from '../lib/repo/github';
import { parseRepoInput } from '../lib/repo/url';

export function galleryFileName(owner: string, name: string): string {
  return `${owner}__${name}.json`;
}

/** `scripts/gallery.json` is a JSON array of `owner/repo` strings or github.com URLs. */
export function parseGalleryList(raw: unknown): { owner: string; name: string }[] {
  if (!Array.isArray(raw)) throw new Error('gallery list must be an array');
  return raw.map((entry, i) => {
    const parsed = typeof entry === 'string' ? parseRepoInput(entry) : null;
    if (!parsed) throw new Error(`gallery list entry ${i} is not a valid repository`);
    return parsed;
  });
}

type RunJobFn = (argv: string[], deps: { write?: (line: string) => void }) => Promise<number>;

/**
 * Runs the built Sandbox job (`dist/sandbox-job.mjs`, from `npm run build:sandbox`) as a child
 * process, so the gallery uses the exact artefact the Sandbox runs. The job is not imported:
 * bundling it would trigger its own entry point. stderr is dropped.
 */
export function runBuiltJob(
  argv: string[],
  deps: { write?: (line: string) => void },
  opts: { bundle?: string; timeoutMs?: number } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [opts.bundle ?? join(process.cwd(), 'dist', 'sandbox-job.mjs'), ...argv],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    // Collect bytes and decode once: a multi-byte character can straddle two stdout chunks.
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      opts.timeoutMs ?? CAPS.analysisDeadlineMs,
    );
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      deps.write?.(Buffer.concat(chunks).toString('utf8'));
      resolve(code ?? 1);
    });
  });
}

/** Runs the Sandbox job locally and returns its validated Analysis; throws `Error(code)`. */
export async function analyseLocally(
  facts: RepoFacts,
  deps: { runJobFn?: RunJobFn; parse?: (json: unknown) => Analysis } = {},
): Promise<Analysis> {
  const runJobFn = deps.runJobFn ?? ((a, d) => runBuiltJob(a, d));
  const parse = deps.parse ?? parseAnalysis;
  const dir = mkdtempSync(join(tmpdir(), 'cc-gallery-'));
  try {
    const sizesFile = join(dir, 'sizes.json');
    writeFileSync(sizesFile, JSON.stringify(facts.tree));
    const lines: string[] = [];
    await runJobFn(
      [
        '--',
        facts.owner,
        facts.name,
        facts.headSha,
        facts.defaultBranch,
        String(facts.windowFromUnix),
        sizesFile,
      ],
      { write: (l) => lines.push(l) },
    );
    const last = lines
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .at(-1);
    let json: unknown;
    try {
      json = last === undefined ? undefined : JSON.parse(last);
    } catch {
      throw new Error('invalid_output');
    }
    if (typeof json === 'object' && json !== null && 'error' in json) {
      const code = (json as { error: unknown }).error;
      throw new Error(typeof code === 'string' ? code : 'invalid_output');
    }
    try {
      return parse(json);
    } catch {
      throw new Error('invalid_output');
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const JOB_CODES = new Set([
  'bad_argument',
  'too_many_files',
  'clone_failed',
  'stale_head',
  'too_many_commits_in_window',
  'invalid_output',
  'internal_error',
]);

/** An error code, never a message: only known codes pass through. */
function codeOf(e: unknown): string {
  if (e instanceof GitHubError) return e.code;
  if (e instanceof Error && JOB_CODES.has(e.message)) return e.message;
  return 'internal_error';
}

export interface GalleryDeps {
  fetchFacts?: (owner: string, name: string) => Promise<RepoFacts>;
  analyse?: (facts: RepoFacts) => Promise<Analysis>;
  outDir?: string;
}

export interface GalleryResult {
  written: string[];
  failed: { repo: string; code: string }[];
}

export async function buildGallery(
  repos: { owner: string; name: string }[],
  deps: GalleryDeps = {},
): Promise<GalleryResult> {
  const fetchFacts = deps.fetchFacts ?? ((o, n) => fetchRepoFacts(o, n));
  const analyse = deps.analyse ?? ((f) => analyseLocally(f));
  const outDir = deps.outDir ?? join(process.cwd(), 'public', 'gallery');
  const result: GalleryResult = { written: [], failed: [] };

  for (const r of repos) {
    const label = `${r.owner}/${r.name}`;
    try {
      const facts = await fetchFacts(r.owner, r.name);
      const caps = checkCaps(facts);
      if (!caps.ok) {
        result.failed.push({ repo: label, code: caps.code });
        continue;
      }
      const analysis = await analyse(facts);
      if (
        analysis.repo.owner !== facts.owner ||
        analysis.repo.name !== facts.name ||
        analysis.repo.headSha !== facts.headSha
      ) {
        result.failed.push({ repo: label, code: 'invalid_output' });
        continue;
      }
      mkdirSync(outDir, { recursive: true });
      const file = galleryFileName(facts.owner, facts.name);
      writeFileSync(join(outDir, file), `${JSON.stringify(analysis)}\n`);
      result.written.push(file);
    } catch (e) {
      result.failed.push({ repo: label, code: codeOf(e) });
    }
  }
  return result;
}

async function main(): Promise<number> {
  const list = parseGalleryList(
    JSON.parse(readFileSync(join(process.cwd(), 'scripts', 'gallery.json'), 'utf8')),
  );
  const { written, failed } = await buildGallery(list);
  for (const f of written) console.log(`wrote ${f}`);
  for (const f of failed) console.error(`failed ${f.repo}: ${f.code}`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('failed: internal_error');
      process.exitCode = 1;
    },
  );
}
