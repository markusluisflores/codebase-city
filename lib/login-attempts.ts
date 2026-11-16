/**
 * Failed-login store. Task 12a implements this against Postgres (`login_attempts`), storing only
 * HMAC(SESSION_SECRET, "login-ip:" + ip), never the raw IP, and purging rows older than 1 hour.
 *
 * Semantics Task 12a must follow: `tooManyAttempts(ip, now)` is true when 5 or more failures were
 * recorded for `ip` in the 60 seconds before `now`, so the 6th attempt in a minute is refused.
 * Blocked attempts are not recorded, so the window ends 60 s after the 5th failure.
 * The functions receive the raw IP; hashing happens inside the store.
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
