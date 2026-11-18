/**
 * Link to a file at a commit on GitHub. Each path segment goes through `encodeURIComponent` (slashes
 * kept), so a `#`, `?` or `%` in a repo-derived path cannot change the URL's structure.
 */
export function githubFileUrl(
  repo: { owner: string; name: string },
  headSha: string,
  path: string,
): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/blob/${headSha}/${encoded}`;
}
