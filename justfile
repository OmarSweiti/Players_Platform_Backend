# The workflow as commands — see CONTRIBUTING.md.
# Recipe parameters are exported with `$name` and read as "$name": they are
# DATA, never interpolated into shell source, so quotes and $(…) stay inert.
set shell := ["bash", "-euo", "pipefail", "-c"]

email := "omarswaty4@gmail.com" # the address linked to the GitHub account
signing_key := env_var("HOME") / ".ssh/id_ed25519.pub" # uploaded to GitHub as a *Signing* key

# List recipes
default:
    @just --list

# Once per clone (and after policy changes): hooks, identity, tag signing, scanner, dependencies
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    # Relative on purpose: Git resolves it per worktree, and an absolute path
    # left behind by a removed worktree disables every hook silently.
    git config core.hooksPath .githooks
    # .git/config is not versioned: without this a clone inherits whatever
    # global identity the machine has, and its commits stop resolving to you.
    git config --local user.email "{{ email }}"
    if [ -f "{{ signing_key }}" ]; then
      git config --local gpg.format ssh
      git config --local user.signingkey "{{ signing_key }}"
      git config --local tag.gpgSign true # release tags must be signed (release.yml refuses others)
      if [ -f "$HOME/.ssh/allowed_signers" ]; then git config --local gpg.ssh.allowedSignersFile "$HOME/.ssh/allowed_signers"; fi
    else
      echo "note: {{ signing_key }} not found — release tags cannot be signed until you set up SSH signing"
    fi
    command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks is required: https://github.com/gitleaks/gitleaks#installing" >&2; exit 1; }
    want=$(cat .nvmrc)
    have=$(node --version 2>/dev/null || echo none)
    [ "$have" = "v$want" ] || echo "note: .nvmrc pins Node $want; this shell has $have (CI uses $want)"
    npm ci --no-audit --no-fund
    echo "core.hooksPath=$(git config core.hooksPath)  user.email=$(git config user.email)  tag.gpgSign=$(git config tag.gpgSign || echo unset)"

# Prove every guard still refuses (CI's guards job runs the same script)
guards:
    bash ./scripts/test-policy.sh

# Lint and format check (not CI gates yet — see the note in ci.yml)
lint:
    npx --no-install eslint "{src,apps,libs,test}/**/*.ts"
    npx --no-install prettier --check "src/**/*.ts" "test/**/*.ts"

# The Prisma schema is valid, and the client generates from it (neither connects)
prisma:
    DATABASE_URL="${DATABASE_URL:-postgresql://ci:ci@localhost:5432/ci}" npx --no-install prisma validate
    DATABASE_URL="${DATABASE_URL:-postgresql://ci:ci@localhost:5432/ci}" npx --no-install prisma generate

# Compile
build:
    npm run build

# Unit tests
test:
    npx --no-install jest

# The same gate as CI's required `test` check
check: prisma build test

# The complete local gate: the CI checks, every guard, and a full-history secret scan
pre-push: check guards
    gitleaks git --config .gitleaks.toml --redact=100 --no-banner --ignore-gitleaks-allow .

# Start work from a fresh development: just branch feat/login-page
branch $name:
    #!/usr/bin/env bash
    set -euo pipefail
    bash ./scripts/validate-branch-flow.sh "$name" development local local
    git switch development
    git pull --ff-only
    git switch -c "$name"

#   just pr                                      one commit: the title is its subject
#   just pr 'feat(auth): add refresh-token rotation  [#42]'  several commits: say it once
#   just pr 'feat(auth): add refresh-token rotation  [#42]' notes/pr.md
# Gate, push, open the PR into development, wait for its required checks
pr $title='' $body='':
    #!/usr/bin/env bash
    set -euo pipefail
    { command -v gh >/dev/null && gh auth status >/dev/null 2>&1; } || { echo "pr: gh must be installed and authenticated" >&2; exit 1; }
    if [ -n "$body" ] && [ -z "$title" ]; then echo "pr: a body file needs a title" >&2; exit 2; fi
    if [ -n "$title" ]; then bash ./scripts/validate-change-title.sh --validate "$title"; fi
    just pre-push
    git push -u origin HEAD
    if [ -n "$body" ]; then
      gh pr create --base development --title "$title" --body-file "$body"
    elif [ -n "$title" ]; then
      git fetch -q origin development
      gh pr create --base development --title "$title" \
        --body "$(git log --reverse --format='- %s' "$(git merge-base origin/development HEAD)"..HEAD)"
    else
      gh pr create --base development --fill-first
    fi
    bash ./scripts/watch-required-checks.sh "$(gh pr view --json url --jq .url)"

# Squash-merge a green WORK PR into development, bound to the exact head that was checked
merge $pr='':
    #!/usr/bin/env bash
    set -euo pipefail
    target=${pr:-$(gh pr view --json url --jq .url)}
    fields=number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,title,body
    snapshot() { gh pr view "$target" --json "$fields" | jq -S -c .; }
    before=$(snapshot)
    get() { jq -r "$1" <<<"$before"; }
    [ "$(get .state)" = OPEN ] && [ "$(get .isDraft)" = false ] || { echo "merge: REFUSED — not an open, ready PR" >&2; exit 1; }
    [ "$(get .baseRefName)" = development ] || { echo "merge: REFUSED — only work PRs into development are squash-merged" >&2; exit 1; }
    case "$(get .headRefName)" in
      development | staging | main | hotfix/*) echo "merge: REFUSED — promotions, back-merges and hotfixes need a merge commit" >&2; exit 1 ;;
    esac
    repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
    bash ./scripts/validate-branch-flow.sh "$(get .headRefName)" development "$(get .headRepository.nameWithOwner)" "$repo"
    bash ./scripts/validate-change-title.sh --validate "$(get .title)"
    text=$(mktemp)
    trap 'rm -f "$text"' EXIT
    get '.title + "\n" + (.body // "")' >"$text"
    bash ./scripts/check-attribution.sh --message-file "$text"
    bash ./scripts/watch-required-checks.sh "$target"
    [ "$(snapshot)" = "$before" ] || { echo "merge: REFUSED — the PR changed while its checks ran; run again" >&2; exit 1; }
    get '.body // ""' >"$text"
    gh pr merge "$target" --squash --delete-branch --match-head-commit "$(get .headRefOid)" \
      --subject "$(get .title) (#$(get .number))" --body-file "$text"

# Open the development → staging promotion (a release candidate)
promote-staging:
    gh pr create --base staging --head development --title "promote development to staging" --body-file .github/PULL_REQUEST_TEMPLATE/promotion.md

# Open the staging → main promotion (production)
promote-main:
    gh pr create --base main --head staging --title "promote staging to main" --body-file .github/PULL_REQUEST_TEMPLATE/promotion.md

# Merge a promotion with a MERGE COMMIT once every required check is green: just promote-merge 42
promote-merge $pr:
    #!/usr/bin/env bash
    set -euo pipefail
    fields=number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,title,body
    snapshot() { gh pr view "$pr" --json "$fields" | jq -S -c .; }
    before=$(snapshot)
    get() { jq -r "$1" <<<"$before"; }
    [ "$(get .state)" = OPEN ] && [ "$(get .isDraft)" = false ] || { echo "promote-merge: REFUSED — not an open, ready PR" >&2; exit 1; }
    route="$(get .headRefName) -> $(get .baseRefName)"
    case "$route" in
      "development -> staging" | "staging -> main") ;;
      *) echo "promote-merge: REFUSED — $route is not a promotion route" >&2; exit 1 ;;
    esac
    repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
    [ "$(get .headRepository.nameWithOwner)" = "$repo" ] || { echo "promote-merge: REFUSED — a promotion never comes from a fork" >&2; exit 1; }
    text=$(mktemp)
    trap 'rm -f "$text"' EXIT
    get '.title + "\n" + (.body // "")' >"$text"
    bash ./scripts/check-attribution.sh --message-file "$text"
    bash ./scripts/watch-required-checks.sh "$pr"
    [ "$(snapshot)" = "$before" ] || { echo "promote-merge: REFUSED — the PR changed while its checks ran; run again" >&2; exit 1; }
    get '.body // ""' >"$text"
    # --merge, never --squash. Never --delete-branch: the head is a flow branch.
    gh pr merge "$pr" --merge --match-head-commit "$(get .headRefOid)" \
      --subject "$(get .title) (#$(get .number))" --body-file "$text"

# What is waiting between the branches — read it before promoting
flow:
    @git fetch -q origin
    @echo "── on development, not yet in staging ──"
    @git log --oneline origin/staging..origin/development || true
    @echo "── on staging, not yet in main ──"
    @git log --oneline origin/main..origin/staging || true

# Preview the GitHub configuration this repository wants (read-only)
gh-bootstrap-dry:
    bash ./scripts/gh-bootstrap.sh --dry-run

# Apply it (idempotent)
gh-bootstrap:
    bash ./scripts/gh-bootstrap.sh

# Read the live configuration back and report drift (read-only)
gh-audit:
    bash ./scripts/gh-audit.sh
