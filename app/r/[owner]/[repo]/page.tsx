import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ViewerLoader } from '@/components/ViewerLoader';
import { isGitHubOwner } from '@/lib/repo/url';
import { validateOwnerName } from '@/lib/repo/validate';

type Params = Promise<{ owner: string; repo: string }>;

/** Decoded, validated route params, or null for a name that cannot be a GitHub repo. */
async function readParams(params: Params): Promise<{ owner: string; repo: string } | null> {
  const { owner, repo } = await params;
  let o: string;
  let r: string;
  try {
    o = decodeURIComponent(owner);
    r = decodeURIComponent(repo);
  } catch {
    return null;
  }
  return isGitHubOwner(o) && validateOwnerName(r) ? { owner: o, repo: r } : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const p = await readParams(params);
  return {
    title: p ? `${p.owner.toLowerCase()}/${p.repo.toLowerCase()} · Codebase City` : 'Codebase City',
  };
}

export default async function ViewerPage({ params }: { params: Params }) {
  const p = await readParams(params);
  if (!p) notFound();
  // The API redirects to the lower-case form, so the page does too: one URL per repo.
  const owner = p.owner.toLowerCase();
  const repo = p.repo.toLowerCase();
  if (owner !== p.owner || repo !== p.repo) {
    redirect(`/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }
  return <ViewerLoader owner={owner} repo={repo} />;
}
