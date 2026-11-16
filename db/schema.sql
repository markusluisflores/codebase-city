-- Codebase City database schema (Task 12a). Idempotent: safe to run on every deploy or by hand.
-- Apply with `psql "$DATABASE_URL" -f db/schema.sql` (or paste into the Neon SQL editor).
-- Stores no author email, raw IP, commit subject or raw stderr. All timestamps are UTC.

-- Cached live analyses: one row per (owner, name, schema_version), replaced on re-analysis.
-- owner and name are stored lower-case (GitHub treats them case-insensitively).
CREATE TABLE IF NOT EXISTS analyses (
  owner          text        NOT NULL,
  name           text        NOT NULL,
  schema_version integer     NOT NULL,
  head_sha       text        NOT NULL,
  analysed_at    timestamptz NOT NULL,
  analysis       jsonb       NOT NULL,
  PRIMARY KEY (owner, name, schema_version)
);

-- Analysis jobs. `reserved` is true only while the job holds one unit of quota; `reserved_on` is the
-- UTC date (YYYY-MM-DD) of that reservation, so a release decrements the right day's counter.
CREATE TABLE IF NOT EXISTS jobs (
  id          text        PRIMARY KEY,
  owner       text        NOT NULL,
  name        text        NOT NULL,
  phase       text        NOT NULL,
  error_code  text,
  reserved    boolean     NOT NULL DEFAULT false,
  reserved_on text        NOT NULL,
  created_at  timestamptz NOT NULL
);

-- At most one non-terminal job per repo: concurrent first requests share one row.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_repo
  ON jobs (owner, name)
  WHERE phase NOT IN ('done', 'failed');

-- Global analysis counters: period is 'd:YYYY-MM-DD' or 'm:YYYY-MM' (UTC).
CREATE TABLE IF NOT EXISTS usage_counters (
  period text    PRIMARY KEY,
  count  integer NOT NULL DEFAULT 0 CHECK (count >= 0)
);

-- Login attempts, keyed by HMAC(SESSION_SECRET, 'login-ip:' || ip) as hex, never the raw IP.
-- Rows older than one hour are purged on each insert.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash text        NOT NULL,
  ts      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_ts ON login_attempts (ip_hash, ts);
CREATE INDEX IF NOT EXISTS login_attempts_ts ON login_attempts (ts);
