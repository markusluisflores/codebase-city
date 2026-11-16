export type Commit = {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  time: number;
  subject: string;
  files: string[];
};

const RS = '\x1e';
const US = '\x1f';
/** A record starts with RS, then a full commit hash, then US. Requiring the hash keeps a hostile path that begins with RS from splitting a record. */
const RECORD_START = /\x1e[0-9a-f]{40}(?:[0-9a-f]{24})?\x1f/y;

function isRecordStart(raw: string, pos: number): boolean {
  RECORD_START.lastIndex = pos;
  return RECORD_START.test(raw);
}

/**
 * Parses the NUL-separated (`-z`) output of the history command (see `gitLogRaw`
 * in tests/helpers/makeRepo.ts): each record is RS, hash, US, author name, US,
 * author email, US, unix time, US, subject, NUL, a newline, then the changed
 * paths each ending in NUL. Records that do not parse are skipped.
 *
 * Known limits (adversarial repos): an author name or email containing U+001F
 * shifts the header fields and the commit is skipped; a path shaped exactly like
 * a record start (RS, 40 hex characters, US) can forge a record. Both only skew
 * statistics, never execute anything; revisit if the format gains a nonce.
 */
export function parseLog(raw: string, opts: { dropHashes?: Set<string> } = {}): Commit[] {
  const commits: Commit[] = [];
  let pos = raw.indexOf(RS);
  while (pos !== -1 && pos < raw.length) {
    if (!isRecordStart(raw, pos)) {
      pos = raw.indexOf(RS, pos + 1);
      continue;
    }
    const headerEnd = raw.indexOf('\0', pos);
    if (headerEnd === -1) break;
    const header = raw.slice(pos + 1, headerEnd).split(US);
    pos = headerEnd + 1;
    if (raw[pos] === '\n') pos += 1;

    const files: string[] = [];
    while (pos < raw.length && !isRecordStart(raw, pos)) {
      const end = raw.indexOf('\0', pos);
      if (end === -1) break;
      if (end > pos) files.push(raw.slice(pos, end));
      pos = end + 1;
    }

    const [hash, authorName, authorEmail, timeText, ...subjectParts] = header;
    if (
      header.length < 5 ||
      hash === undefined ||
      authorName === undefined ||
      authorEmail === undefined ||
      timeText === undefined ||
      !/^\d+$/.test(timeText)
    ) {
      continue;
    }
    if (opts.dropHashes?.has(hash)) continue;
    commits.push({
      hash,
      authorName,
      authorEmail,
      time: Number(timeText),
      subject: subjectParts.join(US),
      files,
    });
  }
  return commits;
}
