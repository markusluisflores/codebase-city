# Codebase City

Paste a public GitHub repo URL and get a 3D city plus a 2D treemap of its files, coloured by hotspot, churn, age, bug-fix density, language and ownership, with co-change arcs and a report card of files to read first. Portfolio project for full-stack and AI-engineer applications.

Global workflow rules live in `~/.claude/CLAUDE.md` and apply here automatically.

## Status

Design approved 2026-11-13 (`docs/superpowers/specs/2026-11-13-codebase-city-design.md`) and implementation plan written (`docs/superpowers/plans/2026-11-13-codebase-city.md`). Requirements are in `docs/requirements-seed.md` (decisions D1-D7 and the v1 scope are settled; do not re-open them). Task 0 (Sandbox spike) passed on 2026-11-14 and its findings are in `docs/spikes/2026-11-sandbox-spike.md` (spike code lives on the unmerged `spike/sandbox` branch). Next: merge the findings docs PR, then Task 1 (`chore/scaffold`) and the implementation branches in the plan. No product code, scaffold or app dependencies until then.

## Constraints

- Tier: Standard, confirmed by Markus on 2026-11-13, plus `/security-review` on the ingestion boundary and the password gate.
- Budget: about one week of Claude Code time. Scope discipline matters; FrontRow overran on backend depth and review ceremony.
- No Anthropic API key and no AI feature in v1.
- Hosting: Vercel with Sandbox for the git work, decided 2026-11-13 (see `docs/adr/ADR-001-host-on-vercel.md`; the Sandbox spike passed 2026-11-14; the 8 MB analysis size bound is still to be re-measured in Task 9). Stack and architecture are fixed in the design (Next.js, TypeScript, Vitest, Postgres cache, Three.js, ingestion module run inside a Sandbox). Stack-specific setup (formatter hook, test framework, CI, CodeQL, quality baseline) is Task 1 of the plan and happens on the `chore/scaffold` branch after the findings docs PR merges.
- Interview guide: `docs/project-reviewer.md` holds the hosting comparison and talking points; update it as decisions land.

## Conventions

- Commits follow `~/.claude/standards/git-commit-standard.md`.
- Docs in `docs/` use Mermaid for diagrams, never ASCII art.
- When Markus must run commands, give PowerShell, not bash.
