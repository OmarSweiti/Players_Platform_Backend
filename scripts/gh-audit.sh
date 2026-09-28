#!/usr/bin/env bash
# Read the LIVE configuration back and compare it with the playbook. Read-only.
# A setting changed in the web UI is not a diff and fails no check — this is
# how you notice. Run it after gh-bootstrap.sh, and whenever in doubt.
#   ./scripts/gh-audit.sh            # exit 0 = no drift
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
REPO=${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)} # GH_REPO=owner/name to target one
RULESETS=${RULESETS_DIR:-.github/rulesets}
drift=0
say() { printf '  %-5s %s\n' "$1" "$2"; }
check() { # check <label> <endpoint> <jq expression that must be true>
  local out
  if out=$(gh api "$2" 2>/dev/null) && jq -e "$3" >/dev/null 2>&1 <<<"$out"; then say ok "$1"
  else say DRIFT "$1"; drift=1; fi
}
echo "auditing $REPO"

echo "branches and merging"
check "default branch is development" "repos/$REPO" '.default_branch == "development"'
check "squash ✓ merge commit ✓ rebase ✗" "repos/$REPO" '.allow_squash_merge and .allow_merge_commit and (.allow_rebase_merge | not)'
check "squash commit = PR title + PR body" "repos/$REPO" '.squash_merge_commit_title == "PR_TITLE" and .squash_merge_commit_message == "PR_BODY"'
check "merge commit = PR title + PR body" "repos/$REPO" '.merge_commit_title == "PR_TITLE" and .merge_commit_message == "PR_BODY"'
check "delete branch on merge · update branch · auto-merge" "repos/$REPO" '.delete_branch_on_merge and .allow_update_branch and .allow_auto_merge'
check "wiki and discussions off" "repos/$REPO" '(.has_wiki | not) and (.has_discussions | not)'
for branch in development staging main; do
  check "branch $branch exists" "repos/$REPO/branches/$branch" '.name != null'
done

echo "security"
check "secret scanning + push protection" "repos/$REPO" '.security_and_analysis.secret_scanning.status == "enabled" and .security_and_analysis.secret_scanning_push_protection.status == "enabled"'
if gh api "repos/$REPO/vulnerability-alerts" >/dev/null 2>&1; then say ok "Dependabot alerts"; else say DRIFT "Dependabot alerts"; drift=1; fi
check "Dependabot security updates" "repos/$REPO/automated-security-fixes" '.enabled'
check "private vulnerability reporting" "repos/$REPO/private-vulnerability-reporting" '.enabled'
check "CodeQL default setup" "repos/$REPO/code-scanning/default-setup" '.state == "configured"'
check "immutable releases" "repos/$REPO/immutable-releases" '.enabled'

echo "GitHub Actions"
check "actions must be pinned to a full SHA" "repos/$REPO/actions/permissions" '.enabled and .sha_pinning_required == true'
check "default token read-only · cannot approve PRs" "repos/$REPO/actions/permissions/workflow" '.default_workflow_permissions == "read" and (.can_approve_pull_request_reviews | not)'
check "every external contributor's fork PR needs approval" "repos/$REPO/actions/permissions/fork-pr-contributor-approval" '.approval_policy == "all_external_contributors"'
check "release environment reachable from v* tags only" "repos/$REPO/environments/release/deployment-branch-policies" '.total_count == 1 and ([.branch_policies[] | select(.name == "v*" and .type == "tag")] | length == 1)'
check "no repository-level secrets (signing keys belong to the environment)" "repos/$REPO/actions/secrets" '.total_count == 0'

echo "rulesets (live vs $RULESETS/*.json)"
normalize='{name, target, enforcement, conditions, bypass_actors,
  rules: (.rules | map(if .parameters == null then del(.parameters) else . end) | sort_by(.type))}'
live=$(gh api "repos/$REPO/rulesets" 2>/dev/null || echo '[]')
for file in "$RULESETS"/*.json; do
  name=$(jq -r .name "$file")
  id=$(jq -r --arg n "$name" '.[] | select(.name == $n) | .id' <<<"$live")
  if [ -z "$id" ]; then say DRIFT "ruleset $name is missing"; drift=1; continue; fi
  if diff <(jq -S "$normalize" "$file") <(gh api "repos/$REPO/rulesets/$id" | jq -S "$normalize") >/dev/null; then
    say ok "ruleset $name matches its file"
  else
    say DRIFT "ruleset $name differs — diff <(jq -S '$normalize' $file) <(gh api repos/$REPO/rulesets/$id | jq -S ...)"
    drift=1
  fi
done

echo
if [ "$drift" -eq 0 ]; then echo "no drift"; else echo "DRIFT found — fix the live setting, or the file that should record it"; fi
exit "$drift"
