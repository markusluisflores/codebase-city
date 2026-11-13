# Codebase City

Paste a public GitHub repo URL and get a 3D city plus a 2D treemap of its files, coloured by hotspot, churn, age, bug-fix density, language and ownership, with co-change arcs and a report card of files to read first. Portfolio project for full-stack and AI-engineer applications.

Global workflow rules live in `C:\Users\Miko\.claude\CLAUDE.md` and apply here automatically.

## Status

Design phase. Requirements are in `docs/requirements-seed.md` (decisions D1-D7 and the v1 scope are settled; do not re-open them). The design doc is the next artifact. No product code, scaffold or app dependencies until Markus approves it.

## Constraints

- Tier: Standard. Revisit toward Mandatory in the design if cloning untrusted repos runs on a server.
- Budget: about one week of Claude Code time. Scope discipline matters; FrontRow overran on backend depth and review ceremony.
- No Anthropic API key and no AI feature in v1.
- Hosting: Vercel with Sandbox for the git work, decided 2026-11-13 (see `docs/adr/ADR-001-host-on-vercel.md`; the Sandbox spike is still outstanding). Rest of the stack and architecture: not chosen yet (see seed section 8, items 10 and 11). Stack-specific setup (formatter hook, test framework, CI, CodeQL, quality baseline, C4 diagram) is deferred until the design fixes the stack.
- Interview guide: `docs/project-reviewer.md` holds the hosting comparison and talking points; update it as decisions land.

## Conventions

- Commits follow `C:\Users\Miko\.claude\standards\git-commit-standard.md`.
- Docs in `docs/` use Mermaid for diagrams, never ASCII art.
- When Markus must run commands, give PowerShell, not bash.
