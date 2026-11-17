import { handleLogin } from '@/lib/login';
import { postgresLoginAttempts } from '@/lib/db/limits';

// node:crypto (HMAC for the session and the IP hash) needs the Node runtime.
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  return handleLogin(req, { store: postgresLoginAttempts });
}
