#!/usr/bin/env bash
# Shape a GitHub repository to the playbook. Idempotent: creates or updates,
# never deletes (the GitHub default labels go only with --delete-default-labels).
#
#   ./scripts/gh-bootstrap.sh --dry-run                 # read-only: print the plan
#   GH_REPO=owner/name ./scripts/gh-bootstrap.sh        # target a repository by name
#   ./scripts/gh-bootstrap.sh                           # apply
#   ./scripts/gh-bootstrap.sh --delete-default-labels   # apply, and drop bug/enhancement/…
#   ./scripts/gh-audit.sh                               # read everything back afterwards
#
# ORDER MATTERS on a brand-new repository (playbook §15): push the workflows to
# main first, then run this. Rulesets require checks that only exist once the
# workflows exist on the default branch.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0 DELETE_DEFAULTS=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --delete-default-labels) DELETE_DEFAULTS=1 ;;
    *) echo "usage: $0 [--dry-run] [--delete-default-labels]" >&2; exit 2 ;;
  esac
done

# GH_REPO=owner/name targets a repository you have not cloned; otherwise the clone's.
REPO=${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
[ -n "$REPO" ] || { echo "gh-bootstrap: cannot identify the repository (gh auth status?)" >&2; exit 1; }
export GH_REPO=$REPO # so `gh label` targets the same repository
echo "repository: $REPO"
[ "$DRY" -eq 1 ] && echo "(dry run — nothing will change)"

run() { # run <command...> — print it in a dry run, execute it otherwise
  if [ "$DRY" -eq 1 ]; then printf '  would: %s\n' "$*"; else "$@" >/dev/null; fi
}
put_json() { # put_json <METHOD> <endpoint> <json>
  if [ "$DRY" -eq 1 ]; then printf '  would: gh api -X %s %s %s\n' "$1" "$2" "$3"
  else printf '%s' "$3" | gh api -X "$1" "$2" --input - >/dev/null; fi
}
section() { printf '\n== %s\n' "$1"; }
note() { if [ "$DRY" -eq 1 ]; then printf '  → %s (planned)\n' "$1"; else printf '  %s\n' "$1"; fi; }

section "flow branches (development and staging cut from main if missing)"
main_sha=$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)
for branch in development staging; do
  if gh api "repos/$REPO/git/ref/heads/$branch" >/dev/null 2>&1; then
    echo "  $branch exists"
  else
    run gh api -X POST "repos/$REPO/git/refs" -f "ref=refs/heads/$branch" -f "sha=$main_sha"
    note "$branch created from main@${main_sha:0:9}"
  fi
done

section "merge behaviour, features, default branch"
# squash for work PRs · merge commit for promotions · rebase off (a history nobody chose)
run gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true -F allow_merge_commit=true -F allow_rebase_merge=false \
  -F allow_auto_merge=true -F delete_branch_on_merge=true -F allow_update_branch=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -f merge_commit_title=PR_TITLE -f merge_commit_message=PR_BODY \
  -F has_issues=true -F has_projects=true -F has_wiki=false -F has_discussions=false \
  -f default_branch=development
note "squash ✓  merge-commit ✓  rebase ✗  auto-merge ✓  delete-branch ✓  default=development"

section "security"
run gh api -X PUT "repos/$REPO/vulnerability-alerts"
run gh api -X PUT "repos/$REPO/automated-security-fixes"
# The next three are free on a PUBLIC repository and may be refused on a private
# one (paid Secret Protection / Code Security), or — CodeQL — before the repo has
# a supported language. Warn and continue; re-run later.
run gh api -X PUT "repos/$REPO/private-vulnerability-reporting" ||
  echo "  WARNING private vulnerability reporting was refused"
put_json PATCH "repos/$REPO" \
  '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}' ||
  echo "  WARNING secret scanning was refused (a private repo needs Secret Protection)"
run gh api -X PATCH "repos/$REPO/code-scanning/default-setup" -f state=configured -f query_suite=extended ||
  echo "  WARNING CodeQL default setup was refused (no supported language yet, or a private repo without Code Security)"
run gh api -X PUT "repos/$REPO/immutable-releases"
note "Dependabot alerts + security updates · private vulnerability reporting"
note "secret scanning + push protection · CodeQL default setup (extended) · immutable releases"

section "GitHub Actions"
# SHA pinning fails every run that still uses a tag, so enable it only once
# every tracked `uses:` is a full commit SHA.
unpinned=$(grep -rhoE '^[[:space:]-]*uses:[[:space:]]*[^[:space:]#]+' .github/workflows 2>/dev/null |
  sed -E 's/.*uses:[[:space:]]*//' | grep -vE '^(\./|docker://)|@[0-9a-f]{40}$' || true)
if [ -z "$unpinned" ]; then
  run gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
  note "every action is SHA-pinned → sha_pinning_required=true"
else
  echo "  SKIPPED sha_pinning_required — pin these first:"
  printf '%s\n' "$unpinned" | sed 's/^/    /'
fi
run gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
run gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors
note "default GITHUB_TOKEN read-only · Actions cannot approve PRs · every fork PR needs approval"

section "the release environment (its secrets reach v* tags only)"
put_json PUT "repos/$REPO/environments/release" \
  '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
# On a 404 (a dry run before the environment exists) gh prints the error body
# on stdout, so anything but a bare count means "none yet".
have_policy=$(gh api "repos/$REPO/environments/release/deployment-branch-policies" \
  --jq '[.branch_policies[] | select(.name == "v*" and .type == "tag")] | length' 2>/dev/null) || have_policy=0
case "$have_policy" in '' | *[!0-9]*) have_policy=0 ;; esac
if [ "$have_policy" -gt 0 ]; then
  echo "  tag policy v* exists"
else
  run gh api -X POST "repos/$REPO/environments/release/deployment-branch-policies" -f 'name=v*' -f type=tag
  note "tag policy v* created"
fi

section "labels"
label() { run gh label create "$1" --color "$2" --description "$3" --force; }
# type: — mirrors the commit types; applied from the PR title, never from paths
label "type: feat" 1d76db "A new capability"
label "type: fix" d73a4a "Wrong behaviour, corrected"
label "type: test" 0e8a16 "Tests only"
label "type: docs" 0075ca "Documentation only"
label "type: chore" cfd3d7 "Tooling, deps, gates, housekeeping"
label "type: refactor" 5319e7 "Same behaviour, better shape"
label "type: perf" fbca04 "Measured, not asserted"
# area: — mirrors the commit scopes; applied by path (.github/labeler.yml)
label "area: auth" c2e0c6 "Sign-in, registration, 2FA, sessions, tokens"
label "area: users" c2e0c6 "Users, roles, permissions"
label "area: players" c2e0c6 "Player profiles and management"
label "area: contracts" c2e0c6 "Contracts"
label "area: medical" c2e0c6 "Medical records and treatment"
label "area: scouting" c2e0c6 "Scouting reports, assignments, watchlists"
label "area: training" c2e0c6 "Training programmes"
label "area: legal" c2e0c6 "Legal workflows"
label "area: chat" c2e0c6 "Real-time messaging"
label "area: notifications" c2e0c6 "Notifications"
label "area: common" bfd4f2 "Cross-cutting decorators, guards, filters, interceptors, pipes"
label "area: infra" bfd4f2 "Prisma service, mail, storage, events, config, health, bootstrap"
label "area: db" bfd4f2 "Prisma schema, migrations, seed"
label "area: repo" ededed "Workspace, CI, gates, tooling"
label "area: docs" ededed "The documentation set"
# priority:
label "priority: P0" b60205 "Data loss, security breach, or the product is down"
label "priority: P1" ff9f1c "A user cannot complete a normal task"
label "priority: P2" fef2c0 "Wrong, but there is a workaround"
# risk: — these change HOW a PR is reviewed; applied by path
label "risk: security" d93f0b "Auth, secrets, permissions, CI or policy files"
label "risk: migration" d93f0b "Schema change — forward-only, needs a data-migration test"
label "risk: breaking" b60205 "Changes a public contract"
# needs: — why it is not moving
label "needs: decision" fbca04 "Blocked on a decision not yet made"
label "needs: answer" fbca04 "Blocked on someone outside the code"
# meta:
label "meta: dependencies" ededed "Raised by Dependabot"
label "meta: flake" b60205 "A non-deterministic test. Quarantine within the hour"
label "meta: spike" d4c5f9 "Time-boxed investigation; produces a written answer"
label "meta: accepted risk" ededed "Deliberately not fixed; the reason is written down"
label "meta: toolchain gap" ededed "A command or gate that cannot work yet"
if [ "$DELETE_DEFAULTS" -eq 1 ]; then
  for default in bug documentation duplicate enhancement "good first issue" "help wanted" invalid question wontfix; do
    run gh label delete "$default" --yes || true
  done
fi
note "label families: type · area · priority · risk · needs · meta"

section "rulesets (from .github/rulesets/*.json)"
for file in .github/rulesets/*.json; do
  name=$(jq -r .name "$file")
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id")
  if [ -n "$id" ]; then
    run gh api -X PUT "repos/$REPO/rulesets/$id" --input "$file"
    note "updated $name"
  else
    run gh api -X POST "repos/$REPO/rulesets" --input "$file"
    note "created $name"
  fi
done

cat <<'TXT'

Done. Still by hand (no API, or deliberately human):
  · Projects board views: grouping and sorting have no API input (playbook §8.5)
  · a tag-signing key uploaded to GitHub as a *Signing* key (playbook §10.4)
  · environment secrets for release signing, when you have them (never repository secrets)
Then prove it: ./scripts/gh-audit.sh
TXT
