import { requireSession } from '@/lib/session';

// Task 11 delivers the session check only; Task 12b completes the flow (spec section 6).
export async function POST(req: Request): Promise<Response> {
  const denied = await requireSession(req);
  if (denied) return denied;
  return Response.json({ error: 'not_implemented' }, { status: 501 });
}
