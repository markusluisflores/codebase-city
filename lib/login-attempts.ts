/**
 * Login-attempt store. `lib/db/limits.ts` implements it against Postgres (`login_attempts`), storing only
 * HMAC(SESSION_SECRET, "login-ip:" + ip), never the raw IP, and purging rows older than 1 hour.
 *
 * Semantics any implementation must follow (they close a parallel-burst race, so do not change them):
 * - `handleLogin` calls `recordFailedLogin(ip, now)` for EVERY attempt, before comparing the password
 *   (the name is the plan's; it records an attempt, whether or not the password turns out right).
 * - It then calls `tooManyAttempts(ip, now)`, true when MORE than 5 attempts (including this one) were
 *   recorded for `ip` in the 60 seconds before `now`: the 6th attempt in a minute is refused. The insert
 *   must be committed before the count is read (read committed is enough), so at most 5 concurrent
 *   requests can see a count of 5 or fewer.
 * - Do NOT merge the insert and the count into one SQL statement (a CTE shares one snapshot, so the count
 *   misses concurrent inserts and reopens the race). Use two statements, or one counter row updated with
 *   `ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` (the row lock serialises requests).
 * - Count rows with `ts > now - 60s` and no upper bound (instance clocks differ), or use the database clock.
 * - Both functions receive the raw IP; hashing happens inside the store. A throw means deny.
 */
export interface LoginAttemptStore {
  recordFailedLogin(ip: string, now: Date): Promise<void>;
  tooManyAttempts(ip: string, now: Date): Promise<boolean>;
}
