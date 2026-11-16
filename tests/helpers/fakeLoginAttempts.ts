import type { LoginAttemptStore } from '@/lib/login-attempts';

/** In-memory stand-in for the Task 12a store (same semantics: 5 failures in the last minute block). */
export function fakeLoginAttempts(): LoginAttemptStore & { failures: Map<string, Date[]> } {
  const failures = new Map<string, Date[]>();
  return {
    failures,
    async recordFailedLogin(ip, now) {
      failures.set(ip, [...(failures.get(ip) ?? []), now]);
    },
    async tooManyAttempts(ip, now) {
      const recent = (failures.get(ip) ?? []).filter((t) => now.getTime() - t.getTime() < 60_000);
      return recent.length >= 5;
    },
  };
}
