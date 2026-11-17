import { describe, expect, it } from 'vitest';
import { CAPS } from '@/lib/caps';
import {
  GitHubError,
  GitHubRateLimited,
  checkCaps,
  fetchRepoFacts,
  type RepoFacts,
} from '@/lib/repo/github';

const SHA = 'a'.repeat(40);
const LATEST = '2026-10-01T12:00:00Z';
const NOW = new Date('2026-11-16T00:00:00Z');

type Route = (url: URL) => Response | undefined;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function repoBody(over: Record<string, unknown> = {}) {
  return {
    full_name: 'Owner/Repo',
    private: false,
    size: 5000,
    default_branch: 'main',
    ...over,
  };
}

function commitsBody(date = LATEST, sha = SHA) {
  return [{ sha, commit: { committer: { date }, author: { date } } }];
}

function mockFetch(overrides: { repo?: Route; commits?: Route; tree?: Route } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: { ...(init?.headers as Record<string, string>) } });
    const p = url.pathname;
    const route = p.includes('/git/trees/')
      ? overrides.tree
      : p.endsWith('/commits')
        ? overrides.commits
        : overrides.repo;
    const hit = route?.(url);
    if (hit) return hit;
    if (p.includes('/git/trees/')) {
      return json({
        truncated: false,
        tree: [
          { path: 'src', type: 'tree' },
          { path: 'src/a.ts', type: 'blob', size: 10 },
          { path: '.mailmap', type: 'blob', size: 55 },
          { path: 'sub', type: 'commit' },
        ],
      });
    }
    if (p.endsWith('/commits')) {
      return json(commitsBody(), {
        headers: {
          link: '<https://api.github.com/repositories/1/commits?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/commits?per_page=1&page=1234>; rel="last"',
        },
      });
    }
    return json(repoBody());
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const deps = (fetchFn: typeof fetch, token?: string) => ({ fetch: fetchFn, now: () => NOW, token });

describe('fetchRepoFacts', () => {
  it('collects size, total commits from the Link header, head, date and blob tree', async () => {
    const { fetchFn, calls } = mockFetch();
    const facts = await fetchRepoFacts('owner', 'repo', deps(fetchFn));
    expect(facts).toMatchObject({
      owner: 'Owner',
      name: 'Repo',
      sizeKb: 5000,
      totalCommits: 1234,
      headSha: SHA,
      defaultBranch: 'main',
      latestCommitUnix: Date.parse(LATEST) / 1000,
      treeTruncated: false,
    });
    // blobs only; the .mailmap with its size is in the list (Task 9 contract)
    expect(facts.tree).toEqual([
      { path: 'src/a.ts', size: 10 },
      { path: '.mailmap', size: 55 },
    ]);
    // every request goes to api.github.com, built from validated parts
    for (const c of calls) expect(new URL(c.url).origin).toBe('https://api.github.com');
    const commitsCall = calls.find((c) => new URL(c.url).pathname.endsWith('/commits'))!;
    expect(new URL(commitsCall.url).searchParams.get('per_page')).toBe('1'); // the Link-header trick
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/repos/owner/repo',
      '/repos/owner/repo/commits',
      `/repos/owner/repo/git/trees/${SHA}`,
    ]);
  });

  it('computes the window start 24 months before the latest commit', async () => {
    const { fetchFn } = mockFetch();
    const facts = await fetchRepoFacts('owner', 'repo', deps(fetchFn));
    expect(facts.windowFromUnix).toBe(Date.UTC(2024, 9, 1, 12) / 1000);
  });

  it('uses 1 for the total when there is no Link header (single commit)', async () => {
    const { fetchFn } = mockFetch({ commits: () => json(commitsBody()) });
    expect((await fetchRepoFacts('owner', 'repo', deps(fetchFn))).totalCommits).toBe(1);
  });

  it('uses the page count only from rel="last"; next/prev alone fall back to the array length', async () => {
    const onlyNext = mockFetch({
      commits: () =>
        json(commitsBody(), { headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } }),
    });
    expect((await fetchRepoFacts('owner', 'repo', deps(onlyNext.fetchFn))).totalCommits).toBe(1);
    const noPage = mockFetch({
      commits: () =>
        json(commitsBody(), { headers: { link: '<https://api.github.com/x>; rel="last"' } }),
    });
    await expect(fetchRepoFacts('owner', 'repo', deps(noPage.fetchFn))).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('reports a truncated tree without throwing', async () => {
    const { fetchFn } = mockFetch({ tree: () => json({ truncated: true, tree: [] }) });
    expect((await fetchRepoFacts('owner', 'repo', deps(fetchFn))).treeTruncated).toBe(true);
  });

  it('maps a 404 to not_found', async () => {
    const { fetchFn } = mockFetch({ repo: () => json({ message: 'Not Found' }, { status: 404 }) });
    await expect(fetchRepoFacts('owner', 'repo', deps(fetchFn))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('maps a redirect (renamed repo) and a private repo to not_found', async () => {
    const moved = mockFetch({ repo: () => new Response(null, { status: 301 }) });
    await expect(fetchRepoFacts('owner', 'repo', deps(moved.fetchFn))).rejects.toMatchObject({
      code: 'not_found',
    });
    const priv = mockFetch({ repo: () => json(repoBody({ private: true })) });
    await expect(fetchRepoFacts('owner', 'repo', deps(priv.fetchFn))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects a response whose full_name is a different repo', async () => {
    const { fetchFn } = mockFetch({ repo: () => json(repoBody({ full_name: 'evil/other' })) });
    await expect(fetchRepoFacts('owner', 'repo', deps(fetchFn))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it.each([
    ['403 with remaining 0', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }],
    ['429', { status: 429 }],
    ['403 with retry-after', { status: 403, headers: { 'retry-after': '60' } }],
  ])('maps %s to GitHubRateLimited', async (_n, init) => {
    const { fetchFn } = mockFetch({ repo: () => json({ message: 'rate limit' }, init) });
    const err = await fetchRepoFacts('owner', 'repo', deps(fetchFn)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimited);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubRateLimited).code).toBe('github_rate_limited');
  });

  it('maps rate limiting on the later calls too', async () => {
    const { fetchFn } = mockFetch({ tree: () => new Response(null, { status: 429 }) });
    await expect(fetchRepoFacts('owner', 'repo', deps(fetchFn))).rejects.toBeInstanceOf(
      GitHubRateLimited,
    );
  });

  it('maps other failures to github_error and a network error to github_error', async () => {
    const five = mockFetch({ repo: () => new Response('boom', { status: 502 }) });
    await expect(fetchRepoFacts('owner', 'repo', deps(five.fetchFn))).rejects.toMatchObject({
      code: 'github_error',
    });
    const down = (async () => {
      throw new Error('ECONNRESET secret-host');
    }) as unknown as typeof fetch;
    const err = await fetchRepoFacts('owner', 'repo', deps(down)).catch((e: unknown) => e);
    expect((err as GitHubError).code).toBe('github_error');
    expect((err as Error).message).toBe('github_error');
  });

  it('maps an empty repository (409) to empty_repo', async () => {
    const { fetchFn } = mockFetch({
      commits: () => json({ message: 'Git Repository is empty.' }, { status: 409 }),
    });
    await expect(fetchRepoFacts('owner', 'repo', deps(fetchFn))).rejects.toMatchObject({
      code: 'empty_repo',
    });
  });

  it('rejects hostile input before any request', async () => {
    const { fetchFn, calls } = mockFetch();
    for (const [o, n] of [
      ['--upload-pack=x', 'y'],
      ['o', '../x'],
      ['o', 'r;rm'],
      ['o/x', 'r'],
    ] as const) {
      await expect(fetchRepoFacts(o, n, deps(fetchFn))).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(calls).toHaveLength(0);
  });

  describe('latest-commit date sanity (never clamped, never a silent zero-commit analysis)', () => {
    it.each([
      ['1970-01-01T00:00:00Z'],
      ['1999-12-31T23:59:59Z'],
      ['2001-12-31T23:59:59Z'],
      ['2026-11-18T00:00:00Z'], // more than a day after the injected clock
      ['2999-01-01T00:00:00Z'],
      ['not a date'],
      [''],
    ])('rejects %j with invalid_commit_date', async (date) => {
      const { fetchFn } = mockFetch({ commits: () => json(commitsBody(date)) });
      await expect(fetchRepoFacts('owner', 'repo', deps(fetchFn))).rejects.toMatchObject({
        code: 'invalid_commit_date',
      });
    });

    it('rejects a missing or non-string date', async () => {
      const a = mockFetch({ commits: () => json([{ sha: SHA, commit: {} }]) });
      await expect(fetchRepoFacts('owner', 'repo', deps(a.fetchFn))).rejects.toMatchObject({
        code: 'invalid_commit_date',
      });
    });

    it('accepts 2002-01-01 and a date a few hours ahead of the clock', async () => {
      const a = mockFetch({ commits: () => json(commitsBody('2002-01-01T00:00:00Z')) });
      expect((await fetchRepoFacts('owner', 'repo', deps(a.fetchFn))).windowFromUnix).toBe(
        Date.UTC(2000, 0, 1) / 1000,
      );
      const b = mockFetch({ commits: () => json(commitsBody('2026-11-16T05:00:00Z')) });
      await expect(fetchRepoFacts('owner', 'repo', deps(b.fetchFn))).resolves.toBeTruthy();
    });
  });

  describe('API response trust', () => {
    it.each([
      ['non-hex head sha', { commits: () => json(commitsBody(LATEST, 'zz')) }],
      ['uppercase head sha', { commits: () => json(commitsBody(LATEST, 'A'.repeat(40))) }],
      ['commits not an array', { commits: () => json({ sha: SHA }) }],
      ['size not a number', { repo: () => json(repoBody({ size: '5' })) }],
      ['negative size', { repo: () => json(repoBody({ size: -1 })) }],
      ['branch with leading dash', { repo: () => json(repoBody({ default_branch: '--x' })) }],
      ['branch with newline', { repo: () => json(repoBody({ default_branch: 'a\nb' })) }],
      ['tree not an array', { tree: () => json({ truncated: false, tree: 'x' }) }],
      [
        'blob with a fractional size',
        { tree: () => json({ truncated: false, tree: [{ path: 'a', type: 'blob', size: 1.5 }] }) },
      ],
      [
        'blob with a negative size',
        { tree: () => json({ truncated: false, tree: [{ path: 'a', type: 'blob', size: -1 }] }) },
      ],
      [
        'blob with an empty path',
        { tree: () => json({ truncated: false, tree: [{ path: '', type: 'blob', size: 1 }] }) },
      ],
      ['not json', { repo: () => new Response('<html>', { status: 200 }) }],
      [
        'a huge content-length',
        { repo: () => json(repoBody(), { headers: { 'content-length': '99999999999' } }) },
      ],
    ])('rejects %s with bad_response', async (_n, overrides) => {
      const { fetchFn } = mockFetch(overrides);
      const err = await fetchRepoFacts('owner', 'repo', deps(fetchFn)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect((err as GitHubError).code).toBe('bad_response');
    });

    it('keeps the default branch as a label only and never puts it in a request', async () => {
      const { fetchFn, calls } = mockFetch({
        repo: () => json(repoBody({ default_branch: 'feat/a b?#' })),
      });
      const facts = await fetchRepoFacts('owner', 'repo', deps(fetchFn));
      expect(facts.defaultBranch).toBe('feat/a b?#');
      expect(calls.every((c) => !c.url.includes('feat'))).toBe(true);
    });
  });

  describe('token', () => {
    it('sends the injected token only as a bearer header and never in a URL or error', async () => {
      const { fetchFn, calls } = mockFetch();
      await fetchRepoFacts('owner', 'repo', deps(fetchFn, 'ghp_TESTTOKEN'));
      for (const c of calls) {
        expect(c.url).not.toContain('ghp_TESTTOKEN');
        expect(c.headers.authorization ?? c.headers.Authorization).toBe('Bearer ghp_TESTTOKEN');
      }
      const failing = mockFetch({ repo: () => new Response('ghp_TESTTOKEN', { status: 500 }) });
      const err = await fetchRepoFacts(
        'owner',
        'repo',
        deps(failing.fetchFn, 'ghp_TESTTOKEN'),
      ).catch((e: unknown) => e);
      expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(
        'ghp_TESTTOKEN',
      );
    });

    it('sends no Authorization header without a token', async () => {
      const prev = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      try {
        const { fetchFn, calls } = mockFetch();
        await fetchRepoFacts('owner', 'repo', { fetch: fetchFn, now: () => NOW });
        for (const c of calls) {
          expect(c.headers.authorization ?? c.headers.Authorization).toBeUndefined();
        }
      } finally {
        if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
      }
    });
  });
});

function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    owner: 'o',
    name: 'r',
    sizeKb: 1,
    totalCommits: 1,
    latestCommitUnix: 1_700_000_000,
    windowFromUnix: 1_600_000_000,
    headSha: SHA,
    defaultBranch: 'main',
    tree: [],
    treeTruncated: false,
    ...over,
  };
}

describe('checkCaps', () => {
  it('passes a repo at every limit', () => {
    const tree = Array.from({ length: CAPS.maxFiles }, (_, i) => ({ path: `f${i}`, size: 1 }));
    expect(
      checkCaps(facts({ sizeKb: CAPS.maxSizeKb, totalCommits: CAPS.maxTotalCommits, tree }), CAPS),
    ).toEqual({ ok: true });
  });

  it('rejects each cap at limit plus one', () => {
    expect(checkCaps(facts({ sizeKb: CAPS.maxSizeKb + 1 }), CAPS)).toEqual({
      ok: false,
      code: 'repo_too_large',
    });
    expect(checkCaps(facts({ totalCommits: CAPS.maxTotalCommits + 1 }), CAPS)).toEqual({
      ok: false,
      code: 'too_many_commits',
    });
    const tree = Array.from({ length: CAPS.maxFiles + 1 }, (_, i) => ({ path: `f${i}`, size: 1 }));
    expect(checkCaps(facts({ tree }), CAPS)).toEqual({ ok: false, code: 'too_many_files' });
    expect(checkCaps(facts({ treeTruncated: true }), CAPS)).toEqual({
      ok: false,
      code: 'tree_truncated',
    });
  });

  it('uses the TOTAL commit count: 60,000 rejected, 49,999 passes', () => {
    expect(checkCaps(facts({ totalCommits: 60_000 }), CAPS)).toEqual({
      ok: false,
      code: 'too_many_commits',
    });
    expect(checkCaps(facts({ totalCommits: 49_999 }), CAPS)).toEqual({ ok: true });
  });

  it('reports a truncated tree first (its file list and count are not trustworthy)', () => {
    expect(checkCaps(facts({ treeTruncated: true, sizeKb: CAPS.maxSizeKb + 1 }), CAPS)).toEqual({
      ok: false,
      code: 'tree_truncated',
    });
  });
});
