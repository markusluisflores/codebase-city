# ADR-001: Host Codebase City on Vercel (web app plus Sandbox for git work)

**Date:** 2026-11-13
**Status:** Accepted (one verification outstanding: the Sandbox spike, see Consequences)

## Context and Problem Statement

Codebase City analyses a public GitHub repo by cloning it and reading `git log`. The web front end and a gallery of pre-analysed repos are cheap to serve. The live analysis is the hard part: it runs git on untrusted repository content, takes seconds to minutes, and needs a disk. We had to pick a hosting platform and decide where that git work runs. Markus already pays $5 a month for Railway, which currently holds the `the-fourth-official` demo, the only Railway service known to be live (chat-app's worker and Redis have an unknown running state, FrontRow was never deployed, per `../../../docs/deployed-services.md` (the workspace `docs/` folder) at the time of writing).

## Decision Drivers

* About one week of build time. FrontRow overran on backend depth and review ceremony.
* Demo traffic is tiny: 3 to 5 demos a month for friends, colleagues and interviews.
* Running untrusted repos on a server is the main security exposure.
* Cost: $0 idle is preferable to a recurring charge.
* Markus wants to learn a platform he hasn't used for this kind of work (stated on 2026-11-13: "so that we do explore other service").
* Whatever is chosen must keep the git logic portable (a plain TypeScript module), so changing platform later is cheap.

## Considered Options

* **A. Web app plus separate always-on worker (Railway).** Next.js, BullMQ worker, Redis, Postgres. Same shape as chat-app. Cleanest isolation, most services to build and review.
* **B1. One service on Railway, git as a child process.** Simplest build. Git runs next to the web service's secrets.
* **B2. Railway web service plus a separate secret-free ingest service.** Good isolation, one extra small service, always on. Railway Sandboxes (disposable VMs) are an alternative to the second service; reported to be in opt-in beta, unverified.
* **B3. Vercel app plus Vercel Sandbox for git work (chosen).** Site is serverless; each analysis runs in a fresh disposable microVM; results cached in Postgres (Marketplace partner such as Neon).
* **C. Client-only (GitHub API from the browser).** Rejected: per-file history needs roughly one API call per commit, and unauthenticated GitHub API calls are limited to 60 an hour. The offline-CLI variant with static JSON works but loses "paste a URL".

## Decision Outcome

**Chosen: B3, Vercel with Sandbox.** It costs $0 on Hobby at this traffic, gives the strongest isolation for untrusted repos (a fresh microVM per job), serves the gallery as cheap static files, and meets the stated goal of exploring a platform Markus hasn't used for this. The git logic stays a plain module, so Railway (B1 or B2) remains a low-cost fallback.

### Consequences

* ✅ $0 idle cost. Hobby has fixed monthly allowances and a hard cap: hitting one pauses that feature, it does not bill.
* ✅ Untrusted repo content never runs on a machine that holds database credentials.
* ✅ Possible later consolidation: `the-fourth-official` (Next.js) could move too, ending the $5 Railway plan. Not decided.
* ⚠️ Extra code: create a Sandbox, wait, collect output, clean up. Railway B1 needs none of this.
* ⚠️ Sandbox is a newer product. Hobby limits and start-up latency were checked in the 2026-11 spike (`docs/spikes/2026-11-sandbox-spike.md`): 5 Active CPU hours a month, 10 concurrent sandboxes, 45-minute sessions (Vercel docs), start-up 0.52 s median.
* ✅ **Spike passed (2026-11-14):** clone and log of express took about 1.2 s inside a Sandbox; no fallback to Railway B1 or B2 is needed. One item is unconfirmed: the 8 MB analysis size bound, re-measured in Task 8 or 9. Findings: `docs/spikes/2026-11-sandbox-spike.md`.
* ⚠️ Vercel's terms restrict Hobby to personal or non-commercial use (read in the spike); a portfolio demo fits, revisit if it ever earns money.
* ⚠️ Two platforms during any transition period if `the-fourth-official` stays on Railway.

## What would change this decision

* The spike shows slow Sandbox start-up or limits too tight for a normal demo.
* Markus revives chat-app or FrontRow (long-running workers, Redis, Spring Boot): Railway then holds more of the portfolio and the consolidation argument weakens.
* Traffic grows enough that Hobby's hard cap bites, forcing Pro at $20 a month plus per-use charges (uncapped overage).
* A later security or terms finding on either platform.
