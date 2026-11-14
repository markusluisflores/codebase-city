# Codebase City Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Codebase City v1: a public gallery of 3D and 2D repo maps coloured by git-history signals, plus a password-protected live analysis of any public GitHub repo, hosted on Vercel.

**Architecture:** One Next.js app on Vercel. A pure TypeScript ingestion module turns raw `git log` text and a file-size map into a schema-validated `Analysis` JSON. Live jobs run that module inside a disposable Vercel Sandbox; the gallery build runs it locally. The browser lays out and renders the `Analysis` (Three.js city, treemap).

**Tech Stack:** Next.js (App Router) and TypeScript strict, Vitest, zod, d3-hierarchy, Three.js, `@vercel/sandbox`, a Marketplace Postgres (Neon preferred), npm. Versions are whatever is current and at least two weeks old at scaffold time, pinned by the lockfile.

**Spec:** `docs/superpowers/specs/2026-11-13-codebase-city-design.md` (approved 2026-11-13). Also read `docs/adr/ADR-001-host-on-vercel.md`.

## Global Constraints

- Hosting is Vercel Hobby. Allowances are hard caps; nothing may rely on a paid plan.
- Tier is Standard, plus `/security-review` on the ingestion boundary and the gate (Tasks 9 to 12).
- No Anthropic API, no AI feature. No repo content is ever checked out or executed. Clone with `--filter=blob:none --no-checkout`, hooks disabled.
- Window: last 24 months before the repo's latest commit. Git history command uses `--no-merges --no-renames --name-only`; renamed files restart history (state in UI).
- Caps (starting values): repo size 1 GB by API, 20,000 commits in window, 20,000 files at HEAD, 5,000 rendered buildings, 240 s analysis wall clock, 10 live analyses a day and 60 a month. A truncated GitHub tree is a hard reject.
- Heuristic thresholds exactly as spec section 8 (bug-fix regex, at least 3 changes for density, co-change: at most 30 files per commit, at least 3 shared commits, Jaccard at least 0.3, top 5 per file; single-owner district at least 80% of file-touches and at least 5 changes).
- Every heuristic is labelled as a heuristic in the UI. No verdict on whether a repo is "well built".
- No secret in the repo. `DEMO_PASSWORD`, `SESSION_SECRET`, `GITHUB_TOKEN`, database URL are sensitive Vercel variables. No local device path in any committed file.
- Commits follow `~/.claude/standards/git-commit-standard.md`. Never commit to `main`; branches per section "Branches" below.
- Docs diagrams use Mermaid. Tests never touch the network.

## Review Focus

Inputs the spec implies but no task would otherwise test, most likely to bite first. Each has a test in the named task.

1. **Lockfiles and generated files dominate hotspots** (`package-lock.json`, `*.min.js`, `dist/`, `vendor/`, images). A reasonable person expects them out of the report card. Plan-level call, not in the spec: an ignore list affects the report card and hotspot ranking only; the files still appear in the city. Task 7.
2. **Paths with spaces, quotes, unicode or newlines** break line-based `git log` parsing. Use `-z` output. Task 4.
3. **Thin or empty history:** fewer than 20 commits in the window, or zero. Must render with a "thin history" note, not crash or divide by zero. Tasks 5, 7, 15.
4. **Repo URL variants and injection:** trailing `.git`, `www.`, `http://`, uppercase, `/tree/main` suffixes, and strings such as `owner/repo;rm -rf` or `--upload-pack=...`. Task 10.
5. **Degenerate statistics:** all files equal size, all churn equal, one author, a single huge commit. Rank ties and zero-variance cases must give stable, defined output. Tasks 5 to 7.

## Requirement to task map

| Spec requirement | Task |
| ---------------- | ---- |
| Hosting risks (Sandbox limits, shallow clone, read-back, mailmap) | 0 |
| Stack, quality baseline, CI | 1 |
| `Analysis` schema and validation | 2 |
| Ingestion: log parse, window, boundary commits | 3, 4 |
| Bug-fix, ownership, churn, age, language | 5 |
| Co-change | 6 |
| Hotspot, report card, single-owner districts | 7 |
| Orchestrator and gallery build | 8 |
| Sandbox job, safety rules | 9 |
| URL validation, GitHub API, caps | 10 |
| Password gate and session | 11 |
| Cache, jobs, daily and monthly caps, API routes | 12 |
| Layout (treemap and city) | 13 |
| Rendering, colour modes, legends | 14 |
| Viewer UI: details, report card, search, arcs, errors, gallery home | 15 |
| Gallery, deploy, README, demo GIF, packaging | 16 |
| Interview guide kept current | 16 |

## Branches

Implementation starts only after the `docs/requirements-seed` PR (seed, ADR, guide, design, this plan) is reviewed and fully merged into `main`. Then one branch per group, each merged by PR before the next starts: `chore/scaffold` (Tasks 1), `feat/ingestion` (2 to 8), `feat/live-analysis` (0 results applied, 9 to 12), `feat/viewer` (13 to 15), `chore/ship-gallery` (16). Task 0 is a throwaway spike on `spike/sandbox` and is never merged; only its findings doc goes in via a `docs/` branch.

## File structure

```
lib/analysis/{types,schema}.ts        Analysis types and zod schema
lib/ingest/{parseLog,metrics,cochange,report,analyze}.ts
lib/repo/{url,github,caps}.ts          input validation, GitHub API, caps
lib/sandbox/{job.ts,run.ts}            job script (runs in Sandbox) and runner (runs in web function)
lib/session.ts                         copied pattern from the-fourth-official
lib/db/{client,cache,jobs,limits}.ts
lib/layout/{treemap,city}.ts           pure layout
lib/render/{scene,colours,legend}.ts
app/{page,gate,r/[owner]/[repo]}/...   pages; app/api/{analyze,jobs/[id],session}/route.ts
scripts/build-gallery.ts               local gallery build (CLI)
public/gallery/*.json                  committed gallery data
tests/                                 mirrors lib/; tests/helpers/makeRepo.ts
```

---

### Task 0: Sandbox spike (Day 0, throwaway)

**Files:** Create `spikes/sandbox/` on `spike/sandbox` (not merged); Create `docs/spikes/2026-11-sandbox-spike.md` (findings, merged via a `docs/` branch).

**Interfaces:** Produces the findings doc. Tasks 9 and 12 read it.

Needs a Vercel account and a Marketplace Postgres; Markus creates them and supplies access.

- [ ] **Step 1: Measure and record**, each as pass or fail with the number: (a) Sandbox create-to-first-command time; (b) end-to-end clone and `git log` of an express-sized repo inside a Sandbox, pass if 60 s or less; (c) can a web function wait 240 s for a Sandbox, pass if yes on Hobby, otherwise test detached run plus signed callback; (d) read back a 5 MB JSON result from the Sandbox; (e) network policy can limit egress to github.com; (f) `git clone --filter=blob:none --no-checkout --shallow-since=<date>` then `git log` gives per-file change counts equal to a full clone's counts once shallow boundary commits (listed in the repo's shallow file) are dropped, checked on express; (g) `--use-mailmap` cost in a blobless clone; (h) Hobby Sandbox allowance, concurrency and timeout as shown in the Vercel dashboard or docs; (i) stored size of one analysis in Postgres and the free-tier storage limit; (j) read Vercel's Hobby terms for any non-commercial restriction.
- [ ] **Step 2: Decide.** If (b), (c) or (e) fails, or (h) is far below the assumption of about 300 minutes a month, stop and ask Markus: ADR-001 is revisited (Railway B1 or B2). Do not continue to Task 9.
- [ ] **Step 3: Commit the findings doc** with `docs(spike): record Sandbox spike results`. Update the design's "calls" that the spike changed (240 s wait vs callback, shallow clone vs full, mailmap on or off).

### Task 1: Scaffold and quality baseline (`chore/scaffold`)

**Files:** Create the Next.js app skeleton, `.claude/settings.json` hook, `.husky/*`, `eslint.config.mjs`, `commitlint.config.mjs`, `.github/workflows/{ci,codeql}.yml`, `.gitleaks.toml`, `vitest.config.ts`; Modify `.github/dependabot.yml`, `CONTRIBUTING.md`, `CLAUDE.md`.

**Interfaces:** Produces `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.

- [ ] **Step 1:** Scaffold Next.js (App Router, TypeScript strict, no Tailwind decision here: the `design-process` skill decides styling before Task 14).
- [ ] **Step 2:** Apply `~/.claude/standards/nodejs-quality-baseline.md` sections 1 to 8: Husky plus lint-staged, ESLint with `no-explicit-any` as error, `npm audit --audit-level=high` and `tsc --noEmit` in CI, commitlint with the standard's type list and 72-character header, gitleaks pre-commit, CodeQL from the `github-setup` templates. Add the per-file Prettier `PostToolUse` hook to `.claude/settings.json` (pattern from chat-app).
- [ ] **Step 3:** Add a `gitleaks` custom rule blocking local device paths, matching both the backslash rendering of a drive-letter path under a Users folder (with the backslashes doubled in the regex; a single-backslash version silently fails) and the Git-Bash forward-slash rendering, case-insensitive on the drive letter. Spell the patterns only in `.gitleaks.toml`, never in docs, so the docs do not trip the rule. Test: a staged file containing each form is rejected.
- [ ] **Step 4:** Add the `npm` entry to `.github/dependabot.yml`; replace the placeholder in `CONTRIBUTING.md` with real setup commands.
- [ ] **Step 5:** Verify: `npm test` passes with one smoke test, `npm run lint`, `npm run typecheck` and `npm run build` pass, a commit with a bad message is blocked, and CI is green on the PR.
- [ ] **Step 6:** Commit as `chore(scaffold): set up Next.js app and quality baseline`.

### Task 2: `Analysis` types and schema

**Files:** Create `lib/analysis/types.ts`, `lib/analysis/schema.ts`; Test `tests/analysis/schema.test.ts`.

**Interfaces:** Produces `type Analysis`, `type FileStat`, `type CoChange`, `type Report`, `const SCHEMA_VERSION: number`, `analysisSchema` (zod), `parseAnalysis(json: unknown): Analysis` (throws on invalid). `FileStat`: `path, size, language, changes, lastChanged (unix seconds or null for older than window), bugFixes, authors: {key,share}[], mainAuthor: string|null, mainAuthorShare, coChange: CoChange[]`. `CoChange`: `{path, shared, score}`.

- [ ] **Step 1:** Write failing tests: a valid sample parses; missing `schemaVersion` throws; negative size throws; `coChange` longer than 5 throws; a file with `lastChanged: null` is valid.
- [ ] **Step 2:** Implement the types and schema; run tests to pass; commit `feat(analysis): add Analysis schema with validation`.

### Task 3: Fixture repo builder

**Files:** Create `tests/helpers/makeRepo.ts`; Test `tests/helpers/makeRepo.test.ts`.

**Interfaces:** Produces `makeRepo(commits: {author:string; email:string; time:number; subject:string; files:Record<string,string>}[]): Promise<{dir:string; cleanup():Promise<void>}>` (a real local git repo built by scripted commits, deterministic timestamps) and `gitLogRaw(dir, sinceUnix?): string` that runs the exact history command from the spec.

- [ ] **Step 1:** Test: three scripted commits produce a repo whose `gitLogRaw` output contains all three subjects and file paths; a path with a space, a quote and a unicode character is present.
- [ ] **Step 2:** Implement using the system `git`; commit `test(helpers): add scripted fixture repo builder`.

### Task 4: Log parser (`feat/ingestion` begins)

**Files:** Create `lib/ingest/parseLog.ts`; Test `tests/ingest/parseLog.test.ts`.

**Interfaces:** Consumes `gitLogRaw` format from Task 3. Produces `type Commit = {hash, authorName, authorEmail, time, subject, files: string[]}` and `parseLog(raw: string, opts?: {dropHashes?: Set<string>}): Commit[]`.

- [ ] **Step 1:** Failing tests using `makeRepo`: commit with path containing space, double quote, unicode and a newline-free tab character parses to the exact path (Review Focus 2); commit with no files returns `files: []`; `dropHashes` removes shallow boundary commits; an empty string returns `[]`; empty author name or email is kept as an empty string.
- [ ] **Step 2:** Implement parsing of NUL-separated (`-z`) output; run tests; commit `feat(ingest): parse git log output including awkward paths`.

### Task 5: Per-file metrics

**Files:** Create `lib/ingest/metrics.ts`; Test `tests/ingest/metrics.test.ts`.

**Interfaces:** Produces `isBugFix(subject: string): boolean`, `isBot(name: string, email: string): boolean`, `authorKey(email: string): string`, `languageOf(path: string): string`, `computeFileStats(commits: Commit[], head: {path:string; size:number}[], windowFromUnix: number): FileStat[]` (without `coChange`).

- [ ] **Step 1:** Failing tests: `isBugFix` true for "Fix crash on empty input", "fixes #12", "hotfix: login", false for "fix typo in README", "lint fixes", "docs: fix link", "prefix handling" (word boundary); `authorKey` lowercases and turns `123+jane@users.noreply.github.com` into `jane@users.noreply.github.com`; `isBot` true for `dependabot[bot]` and `renovate`; `computeFileStats` counts changes and bug-fixes only inside the window, excludes bot commits from authors, sets `lastChanged: null` for files with no in-window commit, still lists those files, yields `mainAuthor: null` when no author. One author and all-equal values must not throw (Review Focus 5).
- [ ] **Step 2:** Implement; run tests; commit `feat(ingest): compute churn, bug-fix and ownership per file`.

### Task 6: Co-change

**Files:** Create `lib/ingest/cochange.ts`; Test `tests/ingest/cochange.test.ts`.

**Interfaces:** Produces `computeCoChange(commits: Commit[], headPaths: Set<string>): Map<string, CoChange[]>`.

- [ ] **Step 1:** Failing tests: two files changed together in 4 of 5 commits give the exact Jaccard score 0.8 and shared 4; a commit with 31 files contributes nothing to co-change; pairs with shared 2 are dropped; score under 0.3 dropped; at most 5 per file, ordered by score then path; files not at HEAD never appear; a file with fewer than 3 changes gets none.
- [ ] **Step 2:** Implement with pair counting over commits of 30 files or fewer; run tests; commit `feat(ingest): compute co-change coupling between files`.

### Task 7: Hotspot, report card, districts

**Files:** Create `lib/ingest/report.ts`; Test `tests/ingest/report.test.ts`.

**Interfaces:** Produces `const IGNORED_FOR_REPORT: RegExp[]`, `hotspotScore(files: FileStat[]): Map<string, number>`, `buildReport(files: FileStat[]): Report` (`readFirst`, `riskiest`, `forgotten`: 10 paths each), `singleOwnerDistricts(files: FileStat[]): string[]`.

- [ ] **Step 1:** Failing tests: hotspot is rank(changes) times rank(size), 0 to 1, with defined output when every value ties (Review Focus 5); `package-lock.json`, `*.min.js`, `dist/**`, `vendor/**` and images never appear in any report list even when they top the raw score (Review Focus 1); `readFirst` uses weights 0.5, 0.3, 0.2 from the spec; `riskiest` excludes files under 3 changes; `forgotten` lists no-window files by size descending then oldest in-window, only above median size, ties by size then path; fewer than 10 candidates returns fewer, not padding; empty file list returns empty lists (Review Focus 3); a district with one author at 80% and 5 changes is flagged, at 79% is not.
- [ ] **Step 2:** Implement; run tests; commit `feat(ingest): compute hotspot, report card and single-owner districts`.

### Task 8: Orchestrator and gallery build

**Files:** Create `lib/ingest/analyze.ts`, `scripts/build-gallery.ts`, `scripts/gallery.json` (curated list); Test `tests/ingest/analyze.test.ts`.

**Interfaces:** Produces `analyze(input: {repo: RepoMeta; rawLog: string; head: {path:string; size:number}[]; dropHashes?: Set<string>; windowFromUnix: number}): Analysis` and `windowStart(latestCommitUnix: number): number` (24 months earlier). `RepoMeta`: `{owner, name, headSha, defaultBranch}`. Consumes Tasks 4 to 7.

- [ ] **Step 1:** Failing tests on a `makeRepo` fixture: end-to-end `analyze` output passes `parseAnalysis`; a repo with 3 commits sets `stats.thinHistory: true`; an empty log returns a valid `Analysis` with every file cold (Review Focus 3); `stats.bugFixCommitShare` and `botCommitsExcluded` are correct; `windowStart` handles a leap day.
- [ ] **Step 2:** Implement `analyze`. Implement `build-gallery.ts`: reads `scripts/gallery.json`, does a local blobless clone into a temp directory, gets sizes from the GitHub trees API with `GITHUB_TOKEN`, writes `public/gallery/<owner>__<repo>.json`. Add a test that fails if any committed gallery file has an out-of-date `schemaVersion` (passes trivially with zero files).
- [ ] **Step 3:** Run tests; commit `feat(ingest): add analyze orchestrator and gallery build script`. Open the `feat/ingestion` PR.

### Task 9: Sandbox job and runner (`feat/live-analysis`)

**Files:** Create `lib/sandbox/job.ts`, `lib/sandbox/run.ts`; Test `tests/sandbox/job.test.ts`.

**Interfaces:** Produces `job.ts` (bundled into the Sandbox, entry reads args `owner repo windowFromUnix` and a sizes file, prints one `Analysis` JSON line) and `runAnalysisInSandbox(input: {owner:string; name:string; windowFromUnix:number; head:{path:string;size:number}[]; deadlineMs:number}): Promise<Analysis>` which creates a Sandbox, runs, validates with `parseAnalysis`, always destroys the Sandbox, and throws a typed `SandboxError` with code `timeout | clone_failed | invalid_output`. Mechanics follow the Task 0 findings doc (wait vs callback).

- [ ] **Step 1:** Failing tests (Sandbox client mocked, `job.ts` tested against a local fixture repo): clone arguments include `--filter=blob:none --no-checkout` and hook-disabling config and never the user's string; clone URL is built only from validated owner and name; invalid JSON from the Sandbox raises `invalid_output` and the Sandbox is still destroyed; deadline exceeded raises `timeout` and destroys the Sandbox.
- [ ] **Step 2:** Implement; run tests. Run one real end-to-end analysis of a small public repo by hand and record the time.
- [ ] **Step 3:** Run `/security-review` on this diff. Commit `feat(sandbox): run analysis in a disposable Sandbox`.

### Task 10: Repo input, GitHub client, caps

**Files:** Create `lib/repo/url.ts`, `lib/repo/github.ts`, `lib/repo/caps.ts`; Test `tests/repo/*.test.ts`.

**Interfaces:** Produces `parseRepoInput(input: string): {owner:string; name:string} | null`; `fetchRepoFacts(owner, name): Promise<{sizeKb:number; totalCommits:number; latestCommitUnix:number; headSha:string; defaultBranch:string; tree:{path:string;size:number}[]; treeTruncated:boolean}>`; `checkCaps(facts, caps): {ok:true} | {ok:false; code: 'repo_too_large'|'too_many_commits'|'too_many_files'|'tree_truncated'}`; `const CAPS` with the starting values.

- [ ] **Step 1:** Failing tests (Review Focus 4): accepts `owner/repo`, `https://github.com/Owner/Repo.git`, `http://www.github.com/o/r/tree/main`; returns owner and name unchanged in case; rejects `owner/repo;rm -rf`, `--upload-pack=x/y`, `https://evil.com/o/r`, `github.com/o`, names with `..`, empty input. `checkCaps` returns each code at its boundary (limit passes, limit plus one fails); a truncated tree is a reject. `fetchRepoFacts` tested with a mocked `fetch` including the `Link` header total-commit trick and a 403 rate-limit response mapped to a typed `GitHubRateLimited`.
- [ ] **Step 2:** Implement; run tests; commit `feat(repo): validate repo input, fetch facts and enforce caps`.

### Task 11: Password gate and session

**Files:** Create `lib/session.ts`, `app/gate/page.tsx`, `app/api/session/route.ts`, `proxy.ts`; Test `tests/session.test.ts`, `tests/session-route.test.ts`.

**Interfaces:** Produces `createSessionToken`, `verifySessionToken`, `passwordMatches` with the same signatures as `the-fourth-official/lib/session.ts` (copied, not imported). `proxy.ts` gates only `POST /api/analyze` (401 JSON when not signed in).

- [ ] **Step 1:** Port the session tests from the Fourth Official's `tests/session*.test.ts` and add: gallery and viewer routes are reachable without a cookie; a tampered token fails; a wrong password is rate-limited after 5 attempts a minute per IP using the Task 12 store (stub it here, wired in Task 12).
- [ ] **Step 2:** Implement; run tests. Sibling-reuse note: this is a deliberate copy of the existing pattern, domain-separated HMACs included.
- [ ] **Step 3:** `/security-review`; commit `feat(auth): add shared-password gate for live analysis`.

### Task 12: Cache, jobs, limits, API routes

**Files:** Create `lib/db/{client,cache,jobs,limits}.ts`, `app/api/analyze/route.ts`, `app/api/jobs/[id]/route.ts`, `db/schema.sql`; Test `tests/db/*.test.ts`, `tests/api/*.test.ts`.

**Interfaces:** Produces `getCached(owner, name, headSha, schemaVersion): Promise<Analysis|null>`, `putCached(...)`, `createJob(owner, name): Promise<string>`, `setJobPhase(id, phase, errorCode?)`, `getJob(id)`, `consumeQuota(now: Date): Promise<{ok:true}|{ok:false; reason:'daily'|'monthly'}>`. Tables: `analyses`, `jobs`, `usage_counters`. `POST /api/analyze {repo}` returns `{status:'cached', ...}` or `{status:'job', id}`; `GET /api/jobs/:id` returns phase and error code. Consumes Tasks 9 to 11.

- [ ] **Step 1:** Failing tests (in-memory or test-container Postgres, no network): cache key includes head SHA and schema version; the 11th analysis in a day is refused with `daily`, the 61st in a month with `monthly`, counters roll over at UTC midnight and month end; cached hit does not consume quota; the viewer read path never calls GitHub or Sandbox (assert via mocks); every error code maps to the user-facing message in the spec's section 11; the job phases advance in order.
- [ ] **Step 2:** Implement the flow in spec section 6; run tests.
- [ ] **Step 3:** `/security-review`; run an end-to-end live analysis on Vercel preview; commit `feat(api): add analysis jobs, cache and daily and monthly caps`. Open the `feat/live-analysis` PR.

### Task 13: Layout (`feat/viewer`)

**Files:** Create `lib/layout/treemap.ts`, `lib/layout/city.ts`; Test `tests/layout/*.test.ts`.

**Interfaces:** Produces `treemap2D(files: {path:string; size:number}[], width:number, height:number): {path:string; x:number; y:number; w:number; h:number}[]` (squarified, area proportional to size) and `cityLayout(files: {path:string; size:number}[], maxBuildings = 5000): {buildings: {path:string; x:number; z:number; footprint:number; height:number}[]; districts: {path:string; x:number; z:number; w:number; d:number}[]}` (district treemap by file count, equal-footprint buildings in a grid, height on a square-root scale, small files merged into an "other" building past the cap).

- [ ] **Step 1:** Failing tests: treemap areas sum to the container and are proportional to size within tolerance; no rectangles overlap; zero-size files get a minimum area, not NaN; 10,000 files yield at most 5,000 buildings plus district "other" buildings; every district contains its buildings; all-equal sizes give equal heights; an empty list returns empty output.
- [ ] **Step 2:** Implement with d3-hierarchy; run tests; commit `feat(layout): add treemap and city layouts`.

### Task 14: Rendering and colour modes

**Files:** Create `lib/render/{scene,colours,legend}.ts`, `components/CityCanvas.tsx`, `components/TreemapView.tsx`; Test `tests/render/colours.test.ts`.

**Interfaces:** Produces `type ColourMode = 'hotspot'|'churn'|'age'|'bugfix'|'language'|'ownership'`, `colourFor(mode, file: FileStat, ctx: {hotspot: Map<string,number>; now: number; owners: Map<string,string>}): string` (hex), `legendFor(mode): {label:string; stops:{colour:string; text:string}[]; note:string}` (the note says it is a heuristic), and a Three.js scene using one instanced mesh, orbit camera, hover and click picking.

- [ ] **Step 1:** Run the `design-process` skill and get Markus's approval of look and layout before any component code. Then write failing tests: every mode returns a valid hex for every file; cold files (`lastChanged: null`) get the neutral grey in `hotspot`, `churn`, `age`, `bugfix` and `ownership` modes, never undefined (cross-check of colour mode and cold files: these two dimensions interact most because cold files have no data in most modes); the bug-fix mode returns grey for files under 3 changes; legends exist for all six modes and each carries the heuristic note.
- [ ] **Step 2:** Implement `colours.ts` and `legend.ts` (tested). Implement the canvas and treemap views and check by hand: 5,000 buildings at about 60 frames a second on Markus's laptop (record the figure); no automated pixel tests.
- [ ] **Step 3:** Commit `feat(render): add city and treemap views with six colour modes`.

### Task 15: Viewer UI

**Files:** Create `app/r/[owner]/[repo]/page.tsx`, `components/{DetailsPanel,ReportCard,SearchBox,ArcLayer,ErrorState,ThinHistoryNote,AnalyseForm}.tsx`, `app/page.tsx` (gallery home); Test `tests/components/*.test.tsx`.

**Interfaces:** Consumes `Analysis`, `ColourMode`, `cityLayout`, `treemap2D`. The details panel shows size, changes, last changed (or "older than window"), bug-fix commits, main author and a GitHub link to the file; arcs render only for the selected file; the report card's entries fly the camera to the file.

- [ ] **Step 1:** Failing component tests: each error code from spec section 11 renders its own message and no stack trace; a repo with under 20 window commits shows the thin-history note in every history-based mode (Review Focus 3); "older than window" renders for `lastChanged: null`; wrong password and the unauthenticated "enter the password to analyse" state render; polling shows each job phase in order.
- [ ] **Step 2:** Implement pages and components; toggle between 3D and 2D; search selects a building; a file link points to the file on GitHub.
- [ ] **Step 3:** Run `pre-pr-review` and open the `feat/viewer` PR.

### Task 16: Gallery, deploy, packaging (`chore/ship-gallery`)

**Files:** Create `public/gallery/*.json`, `README.md`, `docs/architecture.md` (Mermaid); Modify `scripts/gallery.json`, `docs/project-reviewer.md`, `docs/adr/` (new ADRs for any decision the spike or build changed), `docs/deployed-services.md` in the workspace (new row, secret names only).

**Interfaces:** Consumes the Task 8 build script.

- [ ] **Step 1:** With Markus, choose 6 to 8 gallery repos (well-known repos of different shapes plus his own); run the gallery build; commit the JSON.
- [ ] **Step 2:** Deploy to Vercel; set `DEMO_PASSWORD`, `SESSION_SECRET`, `GITHUB_TOKEN` and the database URL as sensitive variables; record them (names only) and the date in the workspace `docs/deployed-services.md`.
- [ ] **Step 3:** README with a one-screen summary, run instructions, demo GIF, decisions and trade-offs, known limitations (rename history splits, heuristics, caps); architecture diagram; update `docs/project-reviewer.md` with what was built and measured (the "Last plan covered" banner).
- [ ] **Step 4:** Whole-branch review, `/security-review` over the whole app, verify the gallery loads with no cookie and `POST /api/analyze` returns 401 without one, then commit and open the PR. Time slider only if the week has room.

## Self-review notes

- **Spec coverage:** every row of the map above has a task; nothing in the spec's non-goals is implemented.
- **Type consistency:** `Commit`, `FileStat`, `CoChange`, `Report`, `Analysis`, `RepoMeta`, `ColourMode` are defined once (Tasks 2, 4, 8, 14) and reused by name. `parseAnalysis` is the single validator (Tasks 2, 8, 9).
- **Plan-level calls not in the spec** (for Markus to check): the report-card ignore list (Review Focus 1); `-z` parsing; one branch per task group; a spike gate that can stop the plan.
- **Tooling:** commit subjects above are written to the 72-character header limit and the type list in the standard; they get run through the real commitlint hook once Task 1 installs it.
- **Proportion:** about 250 lines against a spec of about 190; code blocks are signatures and test descriptions, not bodies.
