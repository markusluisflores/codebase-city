'use client';

import { useCallback, useEffect, useState } from 'react';

export type SessionView =
  { state: 'unknown' } | { state: 'locked' } | { state: 'unlocked'; expiresAt: string };

const LOCKED: SessionView = { state: 'locked' };

async function readSession(): Promise<SessionView> {
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    const body: unknown = await res.json();
    if (
      res.ok &&
      typeof body === 'object' &&
      body !== null &&
      (body as { unlocked?: unknown }).unlocked === true &&
      typeof (body as { expiresAt?: unknown }).expiresAt === 'string'
    ) {
      return { state: 'unlocked', expiresAt: (body as { expiresAt: string }).expiresAt };
    }
  } catch {
    // Unreadable or unreachable: locked.
  }
  return LOCKED;
}

/**
 * The visitor's own locked/unlocked state. The cookie is HttpOnly, so the page asks `GET /api/session`
 * (public, `no-store`). `unknown` lasts until the first answer; a failed request reads as locked, which
 * only hides gated controls (the gated routes check the real cookie themselves).
 */
export function useSession(): {
  session: SessionView;
  /** Re-reads the state; resolves to whether the visitor is now unlocked. */
  refresh: () => Promise<boolean>;
  /** Removes the cookie; resolves to whether it worked (the state only changes when it did). */
  lock: () => Promise<boolean>;
} {
  const [session, setSession] = useState<SessionView>({ state: 'unknown' });

  const refresh = useCallback(async (): Promise<boolean> => {
    const next = await readSession();
    setSession(next);
    return next.state === 'unlocked';
  }, []);

  useEffect(() => {
    let live = true;
    void readSession().then((next) => {
      if (live) setSession(next);
    });
    return () => {
      live = false;
    };
  }, []);

  const lock = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/session', { method: 'DELETE' });
      if (!res.ok) return false;
    } catch {
      return false;
    }
    setSession(LOCKED);
    return true;
  }, []);

  return { session, refresh, lock };
}
