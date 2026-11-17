import { handleViewer } from '@/lib/api/viewer';

export const runtime = 'nodejs';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ owner: string; name: string }> },
): Promise<Response> {
  const { owner, name } = await ctx.params;
  return handleViewer(owner, name, {}, req.url);
}
