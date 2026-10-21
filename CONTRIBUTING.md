# Contributing

The backend API of the Players Platform (NestJS, Prisma, PostgreSQL). The plan, and the order work happens in,
live in [OmarSweiti/Players_Platform](https://github.com/OmarSweiti/Players_Platform).

## Once per clone

```bash
just setup    # hooks, identity, tag signing, the secret scanner, npm ci
just guards   # every guard proves it still refuses what it must
```

Needs `git`, `gh` (authenticated), `just`, `jq`, `gitleaks` ≥ 8.19 and Node
from `.nvmrc`.

## The flow

```text
feat/<slug> ──squash──► development ──merge commit──► staging ──merge commit──► main
                         (default)                     (candidate: vX.Y.Z-rc.N)  (release: vX.Y.Z)
```

```bash
just branch feat/player-profiles                        # from a fresh development
git commit -m "feat(players): add the player profile endpoints  [#12]"
just pr 'feat(players): add the player profile endpoints  [#12]'  # gate → push → PR (the engineering app) → waits for checks
just evidence <PR URL> report.md shots/    # in the umbrella: the validation evidence, for the head commit
# … the maintainer reviews and approves on GitHub …
just merge                                           # only once approved: squash, bound to the checked head
```

- **Work branches** are `feat|fix|chore|docs|refactor|perf|test/<kebab-slug>`
  and always target `development`. A production emergency is `hotfix/<slug>`
  from `main`.
- **Titles** are `type(scope): summary  [ref]`. The PR title becomes the
  squash commit, so CI checks it. `ref` is `#12` for an issue or `—` for none.
  The scopes are listed in `scripts/validate-change-title.sh`.
- **Promotions** (`just promote-staging`, `just promote-main`, then
  `just promote-merge <PR>`) always use a **merge commit**. A squash would fork
  the branches permanently.
- **Every PR is approved by the maintainer** — Dependabot's too — and GitHub
  enforces it: one approving review from the code owner, dismissed by a new
  push. GitHub refuses an approval from a PR's own author, so `just pr` opens
  the PR as the engineering app (the umbrella's `just engineering-app`),
  assigned to the maintainer with their review requested; commits stay yours.
- **Every PR shows it was validated**: the change run and exercised, with
  screenshots, posted for the head commit by the umbrella's `just evidence`.
  The required `validation` check refuses a PR without it
  (`scripts/check-validation.sh`).
- **No assistant attribution.** Coding assistants are tools, not co-authors:
  `Co-Authored-By:` trailers, "Generated with…" lines and assistant names are
  refused everywhere — commits, branches, titles, PR bodies and comments.

## Migrations

`prisma/migrations/` is forward-only: a committed migration is never edited,
renamed or deleted — the `pre-commit` hook and the `protected-paths` check both
refuse it. Change the schema with the next migration:
`npx prisma migrate dev --name <what-changed>`.

CI replays every migration on an empty PostgreSQL and fails if the resulting
database differs from `schema.prisma` (a schema edit without its migration).
`just migrations` runs the same check locally against a throwaway PostgreSQL in
Docker — never against your development database.

## The API contract

`openapi/openapi.json` is the API's contract (ADR-0010), generated from the
routes and their Zod schemas. Every route declares its success with
`@Returns(schema)` and the problems it raises itself with `@Raises(…)`; the
security and the problems the HTTP pipeline can answer with are added for it
(`src/common/openapi/contract.ts`), and generation fails on a route that
declares no success. After changing a route, run `npm run openapi` and commit
the file. `just contract` checks it as CI does: the file is what the code
generates, and nothing in it breaks `development`'s copy. A breaking change
gets a new version of its route; a reviewed exception is a line of
`openapi/breaking-changes.allowed`, merged to `development` in a pull request
of its own before the change (`scripts/check-breaking-contract.sh`).

## Before you push

`just pre-push` runs the complete local gate: schema validation and client
generation, build, unit tests, every guard, and a full-history secret scan.
`just check` alone is exactly the CI `test` check.

The branch rulesets, the required checks, and the hooks are described in
`.github/rulesets/README.md` and `SECURITY.md`.
