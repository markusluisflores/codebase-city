'use client';

import { useState, type FormEvent } from 'react';
import { safeNextPath } from '@/lib/session';

const MESSAGES: Record<string, string> = {
  wrong_password: 'That password is not correct.',
  too_many_attempts: 'Too many attempts. Wait a minute and try again.',
};

export function GateForm({ next }: { next?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.status === 204) {
        window.location.assign(safeNextPath(next));
        return;
      }
      const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '';
      setError(MESSAGES[code] ?? 'Sign-in is unavailable right now. Please try again later.');
    } catch {
      setError('Sign-in is unavailable right now. Please try again later.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        maxLength={200}
        required
      />
      <button type="submit" disabled={busy}>
        Continue
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
