import { NextResponse, type NextRequest } from 'next/server';
import { isGatedPath } from '@/lib/gate';
import { requireSession } from '@/lib/session';

// Next.js 16 proxy (formerly middleware). It runs for every /api path and decides in code, so the
// matcher cannot drift from the route list. Only the live-analysis route needs a session; the viewer,
// the gallery, the login route and job status stay public. The route handler checks the session again.
export const config = { matcher: ['/api/:path*'] };

export async function proxy(req: NextRequest): Promise<NextResponse | Response> {
  if (!isGatedPath(req.nextUrl.pathname)) return NextResponse.next();
  return (await requireSession(req)) ?? NextResponse.next();
}
