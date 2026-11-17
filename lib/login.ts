import type { LoginAttemptStore } from '@/lib/login-attempts';
import {
  assertSessionConfig,
  clientIp,
  createSessionToken,
  jsonError,
  passwordMatches,
  sessionCookieHeader,
} from '@/lib/session';

const MAX_BODY_CHARS = 1024;
const MAX_PASSWORD_LENGTH = 200;

export interface LoginDeps {
  store: LoginAttemptStore;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/**
 * Password check behind POST /api/session. Order matters: configuration, body shape, the per-IP limit
 * (recorded and checked before the password is compared, so a locked-out guesser learns nothing), then the compare.
 * Logs nothing; responses carry fixed error codes only.
 */
export async function handleLogin(req: Request, deps: LoginDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  let config: { demoPassword: string; secret: string };
  try {
    config = assertSessionConfig(env);
  } catch {
    return jsonError('misconfigured', 503);
  }

  // Requiring JSON makes a cross-site form post impossible without a CORS preflight.
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return jsonError('unsupported_media_type', 415);
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_CHARS) return jsonError('invalid_body', 400);
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return jsonError('invalid_body', 400);

  let password: unknown;
  try {
    password = (JSON.parse(text) as { password?: unknown } | null)?.password;
  } catch {
    return jsonError('invalid_body', 400);
  }
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return jsonError('invalid_body', 400);
  }

  const ip = clientIp(req.headers);
  try {
    // Count this attempt BEFORE comparing, then check the total (which includes this attempt). Under
    // concurrency at most 5 requests can see a total of 5 or fewer, so a parallel burst cannot out-guess
    // the limit, and a store whose write fails denies before any comparison happens.
    await deps.store.recordFailedLogin(ip, now());
    if (await deps.store.tooManyAttempts(ip, now())) {
      return jsonError('too_many_attempts', 429, { 'retry-after': '60' });
    }
    if (!(await passwordMatches(config.secret, password, config.demoPassword))) {
      return jsonError('wrong_password', 401);
    }
  } catch {
    // The limiter is part of the gate: if it cannot be consulted, nobody gets in.
    return jsonError('unavailable', 503);
  }

  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'set-cookie': sessionCookieHeader(await createSessionToken(config.secret, now().getTime())),
    },
  });
}
