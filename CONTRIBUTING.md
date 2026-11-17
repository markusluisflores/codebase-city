# Contributing to Codebase City

## Setup

Requires Node.js 22.12 or later and [gitleaks](https://github.com/gitleaks/gitleaks) (the pre-commit hook needs it).

```powershell
winget install Gitleaks.Gitleaks
npm ci
npm run dev
```

`npm ci` also installs the Husky hooks: gitleaks and lint-staged on commit, commitlint on the message.

| Command             | What it does                   |
| ------------------- | ------------------------------ |
| `npm test`          | Vitest unit tests (no network) |
| `npm run lint`      | ESLint                         |
| `npm run typecheck` | `tsc --noEmit`                 |
| `npm run build`     | Next.js production build       |
| `npm run format`    | Prettier                       |

## Branch Naming

`feat/` `fix/` `ci/` `refactor/` `chore/` `docs/` `test/` followed by a kebab-case description of 40 characters or fewer, for example `feat/treemap-layout`.

## Workflow

1. Branch from `main`. Never commit directly to `main`.
2. Write or update tests for any logic changes.
3. Open a PR using the provided template and fill in every section.
4. CI must be green before merge.

## Commit Messages

`<type>(<scope>): <imperative subject, 72 characters or fewer>`, with a body as the types require, for example `feat(ingest): add git log parser for per-file churn`.

## Bug Reports

See [SECURITY.md](SECURITY.md) for security vulnerabilities. For other bugs use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml) template, only for defects found after merge to `main` or a release.

## Feature Requests

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) template.
