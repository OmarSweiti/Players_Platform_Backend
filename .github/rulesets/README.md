# Rulesets as code

These files are the server-side wall: GitHub itself refuses what they forbid.
Each file is exactly the payload `gh api --method POST repos/:owner/:repo/rulesets --input <file>` accepts.

| File | Target | What it enforces |
|---|---|---|
| `development-flow.json` | `development` | no deletion · no force push · PR required · **the code owner's approval** · squash or merge · 6 required checks, `validation` included · **strict** (branch up to date) |
| `staging-promotion.json` | `staging` | no deletion · no force push · PR required · **the code owner's approval** · **merge commit only** · 5 required checks · not strict |
| `main-append-only.json` | `main` | the `staging` shape: the code owner's approval · merge commit only · 5 required checks · not strict |
| `tags-v-append-only.json` | `v*` tags | no deletion · no move — **no bypass, not even the admin** |

`main` carries the full promotion shape from day one (playbook §5.5): this
repository has no legacy CI that a hotfix branch could lack. Neither `staging`
nor `main` can be strict: promotion merge commits live only on those branches,
so they are permanently ahead of their source and strict would report every
promotion `BEHIND`.

**Review on every flow branch.** One approving review, from the code owner
(`CODEOWNERS`: the maintainer, on every path); a new push dismisses an earlier
approval, so what is approved is what merges; every review conversation is
resolved first. GitHub refuses an approval from a PR's own author, which is why
PRs are opened by the engineering app. `require_last_push_approval` stays off
so the maintainer may push a fix to such a PR; the preview setting
`require_extra_approval_for_unattributed_changes` is set off explicitly,
because the documented rules above already require the maintainer's approval
and the preview's behaviour is undocumented. Dependabot's PRs need the same
approval.

**`validation`** (`development` only): the PR's head commit carries validation
evidence — `scripts/check-validation.sh`, run by `.github/workflows/validation.yml`.
Promotions carry changes already validated on their own PRs.

The Admin role may bypass the branch rulesets **through a pull request only**
(never a direct push), and GitHub records every bypass: an emergency path for
the maintainer, never a recipe's.

```bash
./scripts/gh-bootstrap.sh     # create or update every ruleset from these files (idempotent)
./scripts/gh-audit.sh         # diff every live ruleset against its file — expect "no drift"

# by hand
gh api --method POST repos/:owner/:repo/rulesets --input .github/rulesets/<name>.json      # restore
gh api --method PUT  repos/:owner/:repo/rulesets/<id> --input .github/rulesets/<name>.json # update
```

Read rulesets with `gh api repos/:owner/:repo/rulesets`, never with
`branches/<b>/protection`: that is the legacy API, blind to rulesets — it
answers `404 Branch not protected` for a branch a ruleset protects.

Nothing enforces agreement between these files and the live rulesets: a change
in the web UI is not a diff. Drift is detected (`gh-audit.sh`), not prevented.
