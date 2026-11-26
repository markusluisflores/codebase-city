# Password entry and re-analyse: mockup and decisions

Implemented on `feat/password-reanalyse-ux` (Mandatory tier). Implementers of UI tasks must invoke `frontend-design` before writing components.

**Reality moved after this was written (2026-11-25, PRs 29 to 31):** analysis limits are per client IP, not per session cookie (the cookie is a timestamp anyone with the password can mint), so the counter is "N analyses left today" taken from the `analysesLeft` in the new-job response and shown after a run, not from the status route; the status route returns only `{unlocked, expiresAt}`. The home page is ISR (`revalidate = 60`), still client-driven for the unlocked state. "Browse the gallery" button dropped (the gallery is directly below).

## 1. Consistency audit (what exists today)

- **Input model:** plain text form fields, JSON bodies, nothing in URLs. Password read via `FormData` at submit, never held in state, `form.reset()` after use (`AnalyseForm.tsx:164-187`).
- **Output/state:** one `Step` state machine in `AnalyseForm` (idle, starting, running, needPassword, done, error). Errors via `ErrorState` (`role="alert"`, fixed messages from `lib/errors.ts`, never server text). Progress via `<ol aria-label="Analysis progress">` plus a hidden `role="status" aria-live="polite"` line ("Step 2 of 4: ...").
- **Actions:** one primary orange `.button` per block (`states.module.css`), labelled buttons, no icon-only buttons, no modals anywhere in the app (the viewer uses panels and a drawer).
- **Organisation:** home = hero (title, tagline, form) + gallery; viewer = `/r/owner/repo`; the not-analysed state in `ViewerLoader.tsx` reuses `AnalyseForm` with the repo prefilled and `onDone={reload}`.
- **Tokens:** Night Ember, dark only (`--bg #0b1020`, `--surface #131a2e`, `--accent #fb923c`, `--muted #94a3b8`), Fira Sans/Code.
- **Identity check:** the product is "a public gallery of cities you can fly through", with live analysis as a gated extra. The current home page leads with the gated extra (a form every visitor can see and most cannot use). Putting the gallery first extends what the system is; leading with a form imports a "tool you log into" identity. Conscious deviation: none needed.
- **Findings from reading the code:**
  1. The home page is static (rendered at build time), and the cookie is `HttpOnly`, so the page cannot know if the visitor is unlocked. Any "unlocked" UI needs a status signal. Recommended: `GET /api/session` returning `{unlocked, expiresAt}` (`Cache-Control: no-store`; `/api/session` is already public, no proxy change). It can later carry `analysesLeft` from the limit session.
  2. `app/gate/page.tsx` + `GateForm.tsx` are leftover from the Fourth Official pattern and nothing links to them (the API returns 401 JSON, no redirect). Delete them or fold into the new unlock panel; do not leave two password UIs.
  3. `.row input` inherits the 15px body size, so iOS Safari zooms the page on focus. Inputs need `font-size: 16px`. Touch targets are about 34px; need 44px.
  4. The existing flow already does the right thing server side for re-analysis: `handleAnalyze` returns `cached` when the head SHA is unchanged (no quota) and starts a job when it moved. So **re-analyse needs no API change**; the viewer simply never calls it for an already-open analysis.
  5. `/api/analysis/...` is cached on the CDN (`s-maxage=300`), so after a re-analysis finishes the viewer may re-read the old copy for up to 5 minutes. See risk R1.
  6. The session is shared-password: there is no user identity. "Unlocked" means "this browser has a valid 7-day cookie", nothing more.
- **Platform research (from established patterns, not freshly fetched; the `ui-ux-pro-max` search script was missing from the plugin cache, so its Quick Reference rules were used instead):** Vercel/Linear/GitHub put sign-in in the header, not in the page body; "Request access" / "Sign in to continue" is a secondary action, and read-only content stays open. Notion/Figma public links show content to anonymous visitors and attach "Log in to edit" to the action only. GitHub "Re-run jobs" and Vercel "Redeploy" are explicit buttons that say what they cost and disable while running. Relevant ui-ux-pro-max rules: `progressive-disclosure`, `focus-management`, `aria-live-errors`, `touch-target-size` (44px), `password-toggle`, `error-recovery`, `loading-buttons`, `readable-font-size` (16px).

## 2. Options

### Option 1: one submit, "repo + password together" (A)
```
Codebase City
See any repo as a city. Find the files to read first.

Analyse your own repo
Live analysis needs the demo password (shared with reviewers).
GitHub repository  [ vercel/next.js            ]
Demo password      [ ************              ]
                   [ Analyse ]
```
Submit does POST /api/session then POST /api/analyze. After the first success the password field disappears (status route needed) or stays hidden by remembering only "unlocked" in the status. Cheap. Downsides: every recruiter sees a password box they cannot fill, as the first thing; a typo in either field blocks both; no persistent "unlocked" place for a counter or re-analyse.

### Option 2: unlock first, form hidden until unlocked (B + C merged) — RECOMMENDED
Locked (what a recruiter sees; no dead form):
```
Codebase City
See any repo as a city. Find the files to read first.
[ Browse the gallery ]   [ 🔒 Analyse your own repo ]
Gallery cities open for everyone. Analysing a new repo
uses a small hosted compute budget, so it needs a demo password.
```
Click the lock button: a panel expands in place (not a modal), focus moves to the field:
```
[ 🔒 Analyse your own repo ▾ ]
 Demo password  [ ************ ] [ Unlock ]
 That password is not correct.            <- role=alert, under the field
 Cancel
```
Unlocked: the panel becomes the repo form, focus moves to the repo field, and a quiet chip shows state:
```
 🔓 Unlocked until 2 Dec · Lock          (· 4 analyses left)   <- counter only if the limit session ships it
 GitHub repository  [ vercel/next.js ] [ Analyse ]
 ▸ Fetching the repository history        <- existing phase list
```
Phone (375px): buttons stack full width, 44px high, 16px inputs, chip wraps under the title.
Viewer for an uncached repo (`/r/o/r`): the repo is already known, so show **one step**: "o/r is not analysed yet. Enter the demo password to analyse it." [password] [Unlock and analyse]. If already unlocked it shows [Analyse o/r] only. Also "Back to the gallery".
Why it fits: gallery stays the hero; the password is asked before the visitor invests effort typing a repo (Markus's instinct); one persistent place for unlocked state, expiry, Lock, and the per-session counter; same pattern in header-less pages.
Cost: about 1 day. New: `GET` + `DELETE` on `/api/session`, `useSession` hook, `UnlockPanel`, `AnalyseForm` refactor, tests, delete `/gate`.

### Option 3: keep the form visible, ask in a dialog when you press Analyse
Form always shown as today. Pressing Analyse while locked opens a modal "Enter the demo password" over the page; success closes it and continues. Smallest change from today (about 0.5 day) and keeps the typed repo. Downsides: still shows a form most visitors cannot use; introduces the app's only modal (focus trap, scroll lock, new a11y surface); still no persistent unlocked state.

## 3. Recommendation
Option 2. Effort about 1 day plus Mandatory reviews; risk medium (a new public status route and a Lock/DELETE route are the security-relevant surface, the hydration flash needs a reserved height, and it edits `lib/session.ts`/`app/api/session/route.ts`, which the limit session also touches, hence stack it after that PR).

## 4. Re-analyse
- **Where:** the viewer's top bar, beside the analysis date: "Analysed 3 Nov at a1b2c3d · [Check for new commits]".
- **Who:** only unlocked visitors (status route) and only for `source: 'live'` analyses. Gallery repos show no control (their snapshots refresh only on rebuild; tooltip/line: "Gallery snapshot"). Locked visitors see only the date.
- **When:** always available to unlocked visitors on live analyses. No "older than N days" gate, because the viewer never calls GitHub and cannot know the head moved; the server checks. Optional: tint the date "(30+ days ago)".
- **What it does:** `POST /api/analyze {repo}` (unchanged API). Server compares head SHAs. Unchanged: `cached`, no quota, UI says "Up to date: no new commits since a1b2c3d (3 Nov)" (role=status). Moved: a new job.
- **Cost, stated before pressing:** a small inline disclosure under the button: "If the repo has new commits this runs a new analysis: 1 of the shared daily and monthly limit, up to 4 minutes of Sandbox time (and 1 of your N analyses if the counter exists). If nothing changed it costs nothing." [Check and re-analyse] [Cancel]. Quota rule is unchanged (refund only if it fails before the Sandbox starts).
- **While it runs:** the old city stays fully usable; a status strip under the top bar shows "Re-analysing: step 2 of 4, Reading the commit history" (reuses `JOB_PHASES`, `role=status`, polite); button disabled with `aria-busy`. No cancel (the job is server side); closing the page is fine, pressing the button again reuses the running job for free (existing behaviour).
- **On done:** reload the data (`onDone` already exists). **On failure:** `ErrorState` in the strip with retry; the old analysis remains because the cache row is only replaced on success. **On 401 mid-job:** the unlock panel appears in the strip, then continues.
- **Per-session limit:** the counter reads from the status route; at 0 the button is disabled with the limit's own message (the limit session owns the code and wording).

## 5. Accessibility spec (applies to all options, detail for Option 2)
- Lock button: `aria-expanded`, `aria-controls`; Enter/Space opens; focus to password field; Escape or Cancel closes and returns focus to the button.
- Wrong password / too many attempts: `ErrorState` under the field, `role="alert"`; field cleared (`form.reset()`), focus back in the field; messages unchanged (`wrong_password`, `too_many_attempts`, Retry-After 60 s; no countdown).
- Success: `role="status"` "Unlocked. You can analyse a repository now."; focus to the repo field; the chip is text, not colour only (lock glyph + words).
- No password in a URL, state or storage; autocomplete `current-password`; optional show/hide toggle (low value, decision left to the implementer unless Markus wants it).
- 16px inputs, 44px targets, stacked at <480px, reduced-motion respected (no animation on the expand beyond opacity).
- Initial paint renders the locked variant with a reserved min-height; swap after the status fetch (no layout jump larger than the chip).
- Lock (sign out): `DELETE /api/session` clears the cookie; recommended so a shared machine does not stay unlocked 7 days.

## 6. Risks
- R1: CDN `s-maxage=300` may serve the old analysis after re-analysis. Implementation spike: after `done`, compare the loaded `headSha` with the expected one; if equal, show "Updated; the new version appears within about 5 minutes" with a Reload button. Alternative (changes a public contract, needs Mandatory review): shorter s-maxage.
- R2: status route is a new public endpoint: returns only the visitor's own state, `no-store`, no secret, no IP, no counter other than their own.
- R3: files overlap with the limit session (`lib/session.ts`, `app/api/session/route.ts`, `lib/gate.ts`), so stack after it.
- R4: the sandbox cost of an unchanged-schema re-run is never incurred; a forced re-run at the same head is not offered (a schema bump already invalidates the cache).

## Decisions
| Question | Chosen | Why | Tradeoff accepted |
|---|---|---|---|
Answered by Markus directly in this session, 2026-11-25 (the executor session was finished and could not relay).

| Q1: password flow | Option 2 ✅ CHOSEN | gallery first; ask early; persistent unlocked state | one extra click for password holders |
| Q2: Lock/sign-out button | Yes ✅ CHOSEN | shared machines | one more route |
| Q3: re-analyse label + cost disclosure | "Check for new commits" with the inline cost note ✅ CHOSEN | honest about cost | one extra click |
| Q4: viewer not-analysed page: unlock and analyse in one step | Yes ✅ CHOSEN | the repo is already known | different from home |
