import { errorMessage } from '@/lib/errors';
import s from './states.module.css';

/** Codes only the browser can raise (no reply at all, or a reply that was not our JSON). */
const CLIENT_MESSAGES: Record<string, string> = {
  network: "We couldn't reach the server. Check your connection and try again.",
  unreadable: "The server's reply couldn't be read. Please try again.",
};

/** The message for any code: a fixed table entry, never text that came with the failure. */
export function messageFor(code: string): string {
  return Object.prototype.hasOwnProperty.call(CLIENT_MESSAGES, code)
    ? CLIENT_MESSAGES[code]!
    : errorMessage(code);
}

export interface ErrorStateProps {
  code: string;
  /** Shows a retry button when given. */
  onRetry?: () => void;
  retryLabel?: string;
}

/** A failure the visitor can act on. Shows only our own message for the code (never a stack trace or raw server text). */
export function ErrorState({ code, onRetry, retryLabel = 'Try again' }: ErrorStateProps) {
  return (
    <div className={s.error} role="alert">
      <p>{messageFor(code)}</p>
      {onRetry ? (
        <button type="button" className={s.button} onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
