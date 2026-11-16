/**
 * Login-attempt store. Task 12a implements this against Postgres (`login_attempts`), storing only
 * HMAC(SESSION_SECRET, "login-ip:" + ip), never the raw IP, and purging rows older than 1 hour.
 *
 * Semantics Task 12a must follow (they close a parallel-burst race, so do not change them):
 * - `handleLogin` calls `recordFailedLogin(ip, now)` for EVERY attempt, before comparing the password
 *   (the name is the plan's; it records an attempt, whether or not the password turns out right).
 * - It then calls `tooManyAttempts(ip, now)`, true when MORE than 5 attempts (including this one) were
 *   recorded for `ip` in the 60 seconds before `now`: the 6th attempt in a minute is refused. The insert
 *   must be committed before the count is read (read committed is enough), so at most 5 concurrent
 *   requests can see a count of 5 or fewer.
 * - Both functions receive the raw IP; hashing happens inside the store. A throw means deny.
 */
export interface LoginAttemptStore {
  recordFailedLogin(ip: string, now: Date): Promise<void>;
  tooManyAttempts(ip: string, now: Date): Promise<boolean>;
}

/** Placeholder until Task 12b wires the Task 12a store in. It throws, so the login route fails closed (503). */
export const loginAttempts: LoginAttemptStore = {
  async recordFailedLogin() {
    throw new Error('login attempt store is not wired yet (Task 12a/12b)');
  },
  async tooManyAttempts() {
    throw new Error('login attempt store is not wired yet (Task 12a/12b)');
  },
};
