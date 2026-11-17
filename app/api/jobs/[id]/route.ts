import { handleJobStatus } from '@/lib/api/jobs';

export const runtime = 'nodejs';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return handleJobStatus(req, id);
}
