'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ErrorState } from './ErrorState';
import s from './states.module.css';

type Json = Record<string, unknown>;

async function readCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Json | null;
    return typeof body?.error === 'string' ? body.error : 'internal_error';
  } catch {
    return 'internal_error';
  }
}

/**
 * The demo-password form. It posts the password as a JSON body (never in a URL), reads it from the form
 * at submit time (never kept in state), clears the field afterwards and puts focus back in it after a
 * wrong password. `wrong_password` and `too_many_attempts` show under the field; with `onFailure` any
 * other failure is handed to the caller instead.
 */
export function UnlockPanel({
  onUnlocked,
  onFailure,
  onCancel,
  intro,
  submitLabel = 'Continue',
  autoFocus = true,
}: {
  /** Runs after the server set the session cookie (204). */
  onUnlocked: () => void;
  /** Receives codes other than `wrong_password` and `too_many_attempts`; without it they show under the field. */
  onFailure?: (code: string) => void;
  /** Escape calls this (the caller returns focus to what opened the panel). */
  onCancel?: () => void;
  intro?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On open, and again after each answer (the field is disabled while a request is out).
  useEffect(() => {
    if (!busy && (autoFocus || error !== null)) field.current?.focus();
  }, [busy, error, autoFocus]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    if (password === '') return;
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      form.reset();
      setBusy(false);
      return fail('unavailable');
    }
    form.reset();
    if (res.status === 204) {
      setBusy(false);
      return onUnlocked();
    }
    const code = await readCode(res);
    setBusy(false);
    fail(code);
  }

  function fail(code: string) {
    if (code === 'wrong_password' || code === 'too_many_attempts' || !onFailure) setError(code);
    else onFailure(code);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && onCancel) {
      e.stopPropagation();
      onCancel();
    }
  }

  return (
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} aria-busy={busy} className={s.unlock}>
      {intro ? <p>{intro}</p> : null}
      <label htmlFor={`${id}-pw`}>Demo password</label>
      <div className={s.row}>
        <input
          id={`${id}-pw`}
          ref={field}
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={200}
          required
          disabled={busy}
        />
        <button type="submit" className={s.button} disabled={busy}>
          {submitLabel}
        </button>
      </div>
      {error ? <ErrorState code={error} /> : null}
    </form>
  );
}
