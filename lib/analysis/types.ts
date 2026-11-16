/** Hashed author: `key` is a 12-hex-character hash (never an email), `share` is 0 to 1. */
export interface AuthorShare {
  key: string;
  name: string;
  share: number;
}

export interface CoChange {
  path: string;
  /** Commits in which both files changed. */
  shared: number;
  /** Jaccard score, 0 to 1. */
  score: number;
}

export interface FileStat {
  path: string;
  size: number;
  language: string;
  /** Changes inside the window. */
  changes: number;
  /** Unix seconds, or null when older than the window. */
  lastChanged: number | null;
  bugFixes: number;
  /** At most 5. */
  authors: AuthorShare[];
  /** Key of the main author, or null when the file has no author in the window. */
  mainAuthor: string | null;
  mainAuthorShare: number;
  /** At most 5. */
  coChange: CoChange[];
}

export interface District {
  path: string;
  singleOwner: boolean;
  ownerKey: string | null;
  ownerName: string | null;
  /** 0 to 1. */
  ownerShare: number;
  changes: number;
}

/** Report card lists: at most 10 file paths each. */
export interface Report {
  readFirst: string[];
  riskiest: string[];
  forgotten: string[];
}

export interface Analysis {
  schemaVersion: number;
  repo: { owner: string; name: string; headSha: string; defaultBranch: string };
  /** `from` and `to` are unix seconds; `commits` is the commits counted. */
  window: { from: number; to: number; commits: number };
  stats: {
    bugFixCommitShare: number;
    botCommitsExcluded: number;
    commitsInWindow: number;
    thinHistory: boolean;
    mailmapApplied: boolean;
    capsHit: string[];
  };
  files: FileStat[];
  /** At most 2,000. */
  districts: District[];
  report: Report;
}
