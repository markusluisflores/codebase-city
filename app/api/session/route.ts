import { handleLogin } from '@/lib/login';
import { loginAttempts } from '@/lib/login-attempts';

export async function POST(req: Request): Promise<Response> {
  return handleLogin(req, { store: loginAttempts });
}
