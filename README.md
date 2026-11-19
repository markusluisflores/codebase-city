# Codebase City

Paste a public GitHub repo URL and get a 3D city plus a 2D treemap of its files. Colour them by hotspot, churn, age, bug-fix density, language or ownership, see co-change arcs for a selected file, and read a report card of the files to read first. It is a portfolio project: real but modest value, mainly for getting oriented in an unfamiliar repo.

> **Demo GIF: owed.** Not recorded yet (the automated session could not render the 3D view in a hidden browser pane). Placeholder: `docs/demo.gif`.

## At a glance

- **Gallery:** seven pre-analysed repos (express, vite, svelte, django, cargo, vue core, and this author's the-fourth-official) are static JSON in `public/gallery/`. Viewing them needs no password and runs no server work.
- **Live analysis:** `POST /api/analyze` is behind a shared demo password. It checks GitHub for size and commit caps, then runs `git clone` and `git log` inside a disposable Vercel Sandbox, validates the result against a schema and caches it in Postgres. The viewer polls the job every 2 seconds.
- **Viewer:** a Three.js instanced city (up to 5,000 buildings) and a canvas treemap over the same `Analysis`. 60 fps measured on a typical laptop with hardware acceleration (600 frames, p99 17 ms).
- **Stack:** Next.js 16 (App Router, TypeScript), Three.js, d3-hierarchy, Zod, Neon Postgres, Vercel with Sandbox, Vitest.

## Run it locally (PowerShell)

Needs Node 22.12 or newer (CI runs 22) and git.

```powershell
npm ci
npm run dev
```

Open `http://localhost:3000`. The gallery and the viewer work with no environment variables. Live analysis needs a database, Vercel Sandbox access (on Vercel the platform supplies it; locally link the project and pull its env with `vercel env pull`) and these variables (names only; never commit values):

| Variable         | Needed for                                    | Notes                                                                                                                 |
| ---------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | cache, jobs, quota, login limit               | Any Postgres; apply `db/schema.sql` once                                                                              |
| `GITHUB_TOKEN`   | GitHub API calls and `npm run build:gallery`  | Read-only, no scopes needed for public repos; optional locally, but unauthenticated GitHub allows 60 requests an hour |
| `SESSION_SECRET` | signing the session cookie, hashing login IPs | At least 32 characters                                                                                                |
| `DEMO_PASSWORD`  | the password gate                             | At least 16 characters                                                                                                |

Other commands:

```powershell
npm test                 # Vitest
npm run lint
npm run typecheck
npm run build            # bundles the Sandbox job, then next build
npm run build:gallery    # re-analyses the repos in scripts/gallery.json into public/gallery/
```

To rebuild the gallery on PowerShell with a token for the session only: `$env:GITHUB_TOKEN = "<token>"; npm run build:gallery`.

## Decisions and trade-offs

- **Vercel with Sandbox, not a worker service** (`docs/adr/ADR-001-host-on-vercel.md`). One deployable app; git runs in a microVM that exists for one job, so there is no queue or standing worker. The trade-off is Hobby limits: 300 s functions, a monthly Sandbox CPU budget, so live analyses are capped at 10 a day and 60 a month.
- **Blobless, shallow clone** (`--filter=blob:none --no-checkout --shallow-since=<24 months>`). The first measurements showed per-file `git log` on a blobless clone taking minutes because it fetches blobs one by one; `--no-renames` and `--name-only` take well under a second. Sizes come from the GitHub trees API instead.
- **Public gallery, password only on adding repos.** Costs and exposure stay bounded: strangers can browse for free, only the expensive path is gated.
- **The Sandbox holds no secrets.** The web function does every call that needs a credential and validates the Sandbox's JSON before storing it, so a misbehaving job cannot poison the cache.
- **Rank-based heuristics.** Hotspot is the percentile rank of changes times the percentile rank of size, so repo scale and outliers do not distort it. Every colour mode carries a one-line note that it is a heuristic.
- **Arcs live inside the Three.js scene** rather than an overlay, so they move with the camera for free.

Full design: `docs/superpowers/specs/2026-11-13-codebase-city-design.md`. Architecture diagrams: `docs/architecture.md`. Interview notes and measurements: `docs/project-reviewer.md`.

## Known limitations

- **Rename history splits.** Rename detection is off (it is far too slow on a blobless clone), so a renamed file's history starts at the rename.
- **Heuristics, not truth.** Bug-fix density is a regular expression over commit subjects; hotspot and read-first scores are rank formulas; co-change uses only commits touching 30 files or fewer. They suggest where to look, nothing more.
- **A 24-month window.** Churn and bug-fix counts cover the 24 months before the repo's latest commit. Files with no commit in the window stay in the city as "no activity in window" or "older than window".
- **Language by extension and size.** The language colour is picked from extensions, so some repos get a surprising top language (the vite card reads "Image" because of image bytes).
- **Caps.** Live analyses reject repos over 1 GB (GitHub size), over 50,000 total commits, over 20,000 commits in the window, over 10,000 files, a truncated GitHub tree, or a run over 240 s. The city shows at most 5,000 buildings; smaller files in a folder merge into one "other" building. For example `react/react` is about 1.1 GB on GitHub, so it is over the 1 GB cap and is not in the gallery.
- **The password gate is a single shared secret.** It stops casual use and bounds cost; it is not per-user authentication. Wrong guesses are limited to 5 a minute per IP and live analyses are capped globally.
- **Sandbox runtime.** The job runs on a Vercel Sandbox: its network policy allows only GitHub hosts, but the policy was only verified with `curl` and a clone under the policy was not separately tested. Sandbox CPU time per job was not measured, so the daily and monthly caps are estimates.
- **Hand checks still owed:** touch gestures on a real phone, screen-reader pass, reduced-motion pass, and a colour-vision-deficiency pass on all six colour modes.

## Privacy: author keys are pseudonymous

Authors are shown by display name and a key. The key is the first 12 hex characters of an unsalted SHA-256 hash of the author's normalised email. **That is pseudonymisation, not anonymisation.** Anyone who has a known email address can hash it and match it to a key, and display names are shown as git records them (a name containing `@` is cut at the `@`). No email address is stored or served, and no commit message is kept beyond a bug-fix count. For the login limit, visitor IPs are kept only as keyed hashes for up to an hour. The data comes from public repositories.

## Future improvements

- Re-analyse a cached repo behind the password (deferred; the viewer shows the date and commit it was analysed at).
- List analysed repos in the home gallery (they are cached in the database but not listed).
- District labels on the city floor and the treemap.
- Rethink the add-a-repo and password flow (unlock first, or a dedicated "Add a repo" entry).
- The legend covers about 45% of a phone screen; make it collapsible.
- Two greys (others and no activity) look alike under achromatopsia.
- Dependabot ignore rule for `@types/node` majors; TypeScript 7 is held until typescript-eslint supports it; ESLint 9 is deprecated, plan the move.
- Per-session limit on `POST /api/analyze`: GitHub calls happen before the quota check, so someone with the password could use up the GitHub token's hourly limit.
- After the first production deploy, probe that a spoofed `x-vercel-forwarded-for` header cannot defeat the login limit (the header's platform behaviour is still unverified).
- Time slider over history (out of v1 scope).
