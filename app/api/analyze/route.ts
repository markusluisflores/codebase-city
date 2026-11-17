import { handleAnalyze } from '@/lib/api/analyze';

export const runtime = 'nodejs';
// Hobby's function limit. The analysis deadline is 240 s, which leaves about 60 s for cleanup, and the
// job is created only after this function starts, so the 5-minute stale threshold (lib/db/jobs.ts)
// can never pass while the function is still alive.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  return handleAnalyze(req);
}
