# Security

## Status

The Players Platform (Sadara) is in development and has no production
deployment. Nothing here claims a certification, an audit, or a compliance
standard, and nothing should — not in code, docs, API descriptions, or a commit
message — until it has actually been completed.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/OmarSweiti/Players_Platform_Backend/security/advisories/new).

- **Do not open a public issue**, and do not describe the flaw in a PR title.
- Include the affected version or commit and the smallest reproduction you have.
- Never paste a real credential or personal record into the report.

Expect an acknowledgement within a few working days.

## What is enforced by a machine

| Enforced | By |
|---|---|
| No secret in a commit | Gitleaks in `pre-commit`, `pre-push`, CI (`supply-chain`), and a weekly full-history scan; GitHub secret scanning + push protection |
| No sensitive file type (`.env`, keys, database files) or oversized blob | `.githooks/pre-commit` (staged index) |
| A committed migration is never edited, renamed or deleted | `.githooks/pre-commit` + the `protected-paths` required check |
| Changes arrive through pull requests only, on legal routes | rulesets on `development`, `staging`, `main`; the `topology` required check |
| Release tags never move or disappear | the `tags-v-append-only` ruleset, which binds the admin too |
| The schema is valid, the code builds, the unit tests pass | the `test` required check |
| Every migration applies to a real PostgreSQL, and the database it produces is exactly `schema.prisma` | the `test` required check (a PostgreSQL 17 service) |
| No high or critical npm advisory in the lockfile | `npm audit --audit-level high` in the `supply-chain` required check and the weekly security lane; Dependabot alerts + security updates |
| Code-level vulnerabilities are looked for | CodeQL default setup (extended suite) on every PR and weekly |
| Workflow security | SHA-pinned actions (enforced repository-wide), read-only default token, zizmor + actionlint |

## Known gaps

| Gap | What closes it |
|---|---|
| `package.json` overrides `mysql2` and `deepmerge-ts`: the prisma CLI pins vulnerable versions of both (still in prisma 7.10.0) | drop the overrides once a prisma release ships patched versions |
| Lint is not a gate yet: 748 eslint problems at adoption (410 formatting), 65 files not formatted | the changes that clear them add lint and format checks to the `test` check |
| One unit test; no end-to-end tests in CI | tests with the modules they cover; the e2e suite in CI against the same PostgreSQL service |
| No required approvals: a sole maintainer cannot approve their own PR | `required_approving_review_count: 1` when a second developer arrives |
| The admin can bypass the branch rulesets (through a PR only, and logged) | remove the bypass when a second maintainer exists |
