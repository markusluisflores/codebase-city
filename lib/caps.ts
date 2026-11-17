/** Hard caps (design section 8 and the plan's Global Constraints). Consumed by the Sandbox job and the repo checks. */
export const CAPS = {
  /** Repo size limit from the GitHub API, in KB (1 GB). */
  maxSizeKb: 1_048_576,
  /** Total commits, checked before the clone (error code `too_many_commits`). */
  maxTotalCommits: 50_000,
  /** Commits inside the 24-month window, checked by the job (`too_many_commits_in_window`). */
  maxCommitsInWindow: 20_000,
  /** Files at HEAD. */
  maxFiles: 10_000,
  /** Analysis wall clock. */
  analysisDeadlineMs: 240_000,
  /** Largest serialised Analysis accepted from the Sandbox (8 MiB). */
  maxStdoutBytes: 8_388_608,
  /** Headroom below `maxStdoutBytes` for the job's phase lines and trailing newline (1 KiB). */
  stdoutHeadroomBytes: 1024,
} as const;

/** The largest Analysis JSON the job may print: stdout cap minus headroom for phase lines. */
export const MAX_ANALYSIS_BYTES = CAPS.maxStdoutBytes - CAPS.stdoutHeadroomBytes;
