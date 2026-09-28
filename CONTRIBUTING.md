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
just pr 'feat(players): add the player profile endpoints  [#12]'  # gate → push → PR → waits for checks
just merge                                           # squash, bound to the exact head that was checked
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
- **No assistant attribution.** Coding assistants are tools, not co-authors:
  `Co-Authored-By:` trailers and "Generated with…" lines are refused everywhere.

## Migrations

`prisma/migrations/` is forward-only: a committed migration is never edited,
renamed or deleted — the `pre-commit` hook and the `protected-paths` check both
refuse it. Change the schema with the next migration:
`npx prisma migrate dev --name <what-changed>`.

## Before you push

`just pre-push` runs the complete local gate: schema validation and client
generation, build, unit tests, every guard, and a full-history secret scan.
`just check` alone is exactly the CI `test` check.

The branch rulesets, the required checks, and the hooks are described in
`.github/rulesets/README.md` and `SECURITY.md`.
