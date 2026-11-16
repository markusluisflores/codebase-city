import { z } from 'zod';
import { CAPS } from '@/lib/caps';
import { validateOwnerName } from '@/lib/repo/validate';
import type { Analysis } from './types';

export const SCHEMA_VERSION = 1;

const MAX_PATH = 1024;
const MAX_AUTHORS = 5;
const MAX_CO_CHANGE = 5;
const MAX_REPORT = 10;
const MAX_DISTRICTS = 2000;

const path = z.string().min(1).max(MAX_PATH);
const count = z.number().int().nonnegative();
const fraction = z.number().min(0).max(1);
// Pseudonymised author key: 12 lower-case hex characters, never an email.
const authorKey = z.string().regex(/^[0-9a-f]{12}$/);
// Display name: bounded, and never contains `@` (an email must not leak through it).
const displayName = z
  .string()
  .max(200)
  .refine((s) => !s.includes('@'), 'author name must not contain @');

// strictObject everywhere: an unexpected field (an `email`, say) is rejected, not passed through.
const coChange = z.strictObject({ path, shared: count, score: fraction });

const author = z.strictObject({ key: authorKey, name: displayName, share: fraction });

const fileStat = z.strictObject({
  path,
  size: count,
  language: z.string().min(1).max(100),
  changes: count,
  lastChanged: z.number().int().nonnegative().nullable(),
  bugFixes: count,
  authors: z.array(author).max(MAX_AUTHORS),
  // Display name (scrubbed of `@`), as in the spec; not a key.
  mainAuthor: displayName.nullable(),
  mainAuthorShare: fraction,
  coChange: z.array(coChange).max(MAX_CO_CHANGE),
});

const district = z.strictObject({
  path,
  singleOwner: z.boolean(),
  ownerKey: authorKey.nullable(),
  ownerName: displayName.nullable(),
  ownerShare: fraction,
  changes: count,
});

const reportList = z.array(path).max(MAX_REPORT);

const base = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repo: z.strictObject({
    owner: z.string().refine(validateOwnerName, 'invalid owner'),
    name: z.string().refine(validateOwnerName, 'invalid repo name'),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    defaultBranch: z.string().min(1).max(255),
  }),
  window: z.strictObject({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    commits: count,
  }),
  stats: z.strictObject({
    bugFixCommitShare: fraction,
    botCommitsExcluded: count,
    commitsInWindow: count,
    thinHistory: z.boolean(),
    mailmapApplied: z.boolean(),
    capsHit: z.array(z.string().max(100)).max(20),
  }),
  files: z.array(fileStat).max(CAPS.maxFiles),
  districts: z.array(district).max(MAX_DISTRICTS),
  report: z.strictObject({
    readFirst: reportList,
    riskiest: reportList,
    forgotten: reportList,
  }),
});

/** Serialised size in UTF-8 bytes of the validated object. */
function serialisedBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

export const analysisSchema = base.refine((a) => serialisedBytes(a) <= CAPS.maxStdoutBytes, {
  message: 'analysis exceeds the 8 MB serialised size limit',
});

/** Validates untrusted JSON (from the Sandbox or the cache). Throws a ZodError on any violation. */
export function parseAnalysis(json: unknown): Analysis {
  // No cast: this return type-checks only while the schema output is assignable to `Analysis`.
  return analysisSchema.parse(json);
}
