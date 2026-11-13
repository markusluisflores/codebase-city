# Codebase City: Requirements Seed

> **Status:** seed from a brainstorm session on 2026-11-13. **Not an approved design.** It records what was decided and what is still open, so the next session starts from files, not from chat history.
> **Origin:** idea #1 of 10 in `C:\ClaudeProjects\portfolio-project-ideas.md` (ranked shortlist, rationale and sources are there).
> **Next step:** this is the *requirements* half of the brainstorm. The next session still has to lay out the build approaches, get one picked, then write the design doc and get it approved. Per the global workflow, the first branch is `docs/<description>`, and this file should be committed there after `new-project` bootstrap.

Attribution: items marked **(user)** are Markus's decisions or words. Items marked **(proposal)** are my suggestions that he approved or has not yet reviewed. Items marked **(open)** are undecided.

---

## 1. Purpose

**(user)** Point the tool at a repo that isn't yours and learn quickly where to look. The questions he named:

1. Which files are most important and constantly evolving?
2. Where do problems cluster? ("If their issue tracker such as GitHub or Jira are linked as well, it tells me where common problems are.")
3. Which areas are outdated, or have stayed the same as before?
4. Is the folder structure well built or not?

**(user)** He also asked that I not limit the question list to his answers. The additions below are mine, and he approved the first-version cut.

**Honest value statement:** the practical value is real but modest, mainly for unfamiliar repos (onboarding, evaluating a dependency, someone reviewing his own repos). The main purpose is a strong portfolio showcase. Don't oversell it as a daily tool.

## 2. Audience and goal

- **(user)** Portfolio showcase for future job applications, aimed at full-stack roles with an eye on AI-engineer roles.
- **(proposal)** Demo on well-known public repos plus his own, so the demo works with no setup.
- **(user)** Previous project (FrontRow) took too long and was backend-heavy. This one must be visual and UI-accessible, with a thin backend, about 1 week of Claude Code time at most.

## 3. Decisions made

| # | Decision | Source |
|---|---|---|
| D1 | Build Codebase City, chosen over 9 other candidates | user |
| D2 | Provide both a 3D city and a 2D treemap toggle | proposal, approved |
| D3 | "Where are the problems": option C. Bug-fix commits from the git log in v1, GitHub issues and PRs as an optional second layer later | proposal, user chose C |
| D4 | GitHub only. Jira is out of scope (per-company login, can't demo publicly) | proposal |
| D5 | Hotspot = changes × file size as a stand-in for "complicated and constantly edited" (real complexity metrics are heavier) | proposal |
| D6 | Folder structure is shown as *signals*, not a "well built" verdict | proposal |
| D7 | No Anthropic API key needed; no AI feature in v1 | proposal, consistent with budget concern |

## 4. Scope

### In the first version (user approved)

- Ingest a repo's history and file tree.
- 3D city plus 2D treemap toggle. Folders are districts and files are buildings. Height is file size.
- Colour modes: **hotspot, churn, age/staleness, bug-fix density**, plus language.
- Click a building for details: size, number of changes in the window, last changed, bug-fix commits, main author.
- **Repo report card** side panel: top 10 files to read first, top 10 riskiest, top 10 most forgotten.
- **Ownership / bus factor:** colour by main author and flag single-owner districts.
- **Co-change arcs:** click a file and see arcs to files that usually change in the same commits, across folders. Doubles as a folder-structure signal.

### Stretch (only if the week allows)

- Time slider that replays the city being built as files appear.

### Later (not in v1)

- GitHub issues and PRs layer (option B: bug labels, linked PRs, files touched). Needs a token, hits rate limits, only works for repos using GitHub issues.
- Folder-structure signals summary (nesting depth, dumping-ground folders, test-to-code ratio per district).

### Out of scope

- Jira.
- Import and dependency graph (needs per-language parsing, a project of its own).
- AI "explain this district" (needs a key, adds spend risk).

## 5. Non-goals and anti-goals

- A pretty city with no analysis behind it. Prior art makes the plain version undifferentiated.
- A verdict on whether a repo is "well built". Show signals only.
- Scope creep. The week is a hard limit. FrontRow's lesson is that overruns come from extra scope and review ceremony.
- Spending Anthropic tokens.

## 6. Constraints

- About 5–6 days of Claude Code time (my estimate, unvalidated). v1 as scoped, with ownership and co-change arcs, is a full week already.
- Tier: Standard (new feature), per the global risk tiering. Note: the clone step runs untrusted repo content on a server, which may raise parts of this toward Mandatory. Decide in design.
- Existing stack preference (proposal): Next.js and Postgres, hosted on Railway as for chat-app. **(open)**
- Git history approach: clone without file contents ("blobless") but with history, either full or time-bounded (for example the last 2 years). A depth-1 shallow clone breaks churn. Whether reading file sizes in a blobless clone triggers blob downloads needs checking in design.

## 7. Prior art and differentiation

- The idea is established. [CodeCity](https://2011.icse-conferences.org/content/software-systems-cities-controlled-experiment.html) was tested in a 2011 controlled experiment (41 participants) reporting better task correctness and shorter completion time. Baseline unverified, and no treemap-vs-3D comparison found.
- Existing tools include Gource (history animation), open-source "URL to 3D city" projects such as MagnovaAI's `codecity` and Manavarya09's `code-city`, and hosted DevCity AI and LegacyLens. Quality and maintenance unchecked.
- Differentiators for this project: history-based analysis ([hotspots](https://adamtornhill.com/articles/software-revolution/part1/index.html) from git churn), ownership, co-change arcs, a 2D view, and the report card.

## 8. Open questions for the design brainstorm

1. **Input:** public GitHub URLs only? Other hosts? Private repos (probably not)?
2. **History window:** full history, or a default like 2 years? How does it interact with churn and age?
3. **Bug-fix heuristic:** which commit-message patterns? How to show its noise honestly?
4. **Hotspot formula** details and normalisation across repo sizes.
5. **Co-change algorithm:** thresholds, ignoring huge commits, how many files to compute arcs for.
6. **Authorship:** aliases and `.mailmap` handling; bots.
7. **Size caps and timeouts** for large repos, and what the user sees when a cap is hit.
8. **Security of cloning untrusted repos:** sandboxing, no execution of repo content, disk limits.
9. **Job model:** synchronous or queued, progress UI, caching and persistence.
10. **Architecture:** single Next.js app with a background worker, or a separate worker service. A client-only version (GitHub API from the browser) can't get history cheaply, which is the key differentiator.
11. **Stack and deploy target.**
12. **Report card contents** and how each list is computed.
13. **Layout algorithm** for districts and 3D performance budget (instancing, building cap).

## 9. Verify before committing to a design

| Item | Why |
|---|---|
| Blobless clone behaviour when reading file sizes | May trigger blob fetches |
| Real cost and time of cloning and `git log` on large public repos | Sets size caps |
| Quality and maintenance of the competing open-source cities | Sharpens differentiation |

## 10. Risks

- **Scope:** v1 is a full week. Hold the line and treat the time slider as stretch.
- **3D performance** with many files: instancing and a cap on rendered buildings.
- **Noisy signals:** bug-fix heuristic and co-change can mislead. Label them as heuristics in the UI.
- **Cloning untrusted repos:** security-relevant, design-doc topic.

## 11. Provenance

Derived from the brainstorm session of 2026-11-13. Sources are listed in `C:\ClaudeProjects\portfolio-project-ideas.md` (section 7) and in the links above. Most are blogs or secondary summaries, so treat claims as leads to check.
