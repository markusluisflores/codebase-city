import { handleLogin } from '@/lib/login';
import { postgresLoginAttempts } from '@/lib/db/limits';
import { clearedSessionCookieHeader, sessionStatus } from '@/lib/session';

// node:crypto (HMAC for the session and the IP hash) needs the Node runtime.
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  return handleLogin(req, { store: postgresLoginAttempts });
}

/** The visitor's own locked/unlocked state, for the page's display. Public, `no-store`, no secrets. */
export async function GET(req: Request): Promise<Response> {
  return Response.json(await sessionStatus(req), { headers: { 'cache-control': 'no-store' } });
}

/**
 * Lock: removes this browser's cookie. Harmless without one; the password still unlocks again. This is
 * not revocation: the token is stateless and stays valid until it expires, so a copy taken earlier still
 * works. Rotating `SESSION_SECRET` is the kill switch.
 */
export async function DELETE(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store', 'set-cookie': clearedSessionCookieHeader() },
  });
}
