#!/usr/bin/env bash
# Wait until every check the target branch's rulesets REQUIRE has registered
# on the PR, then watch until all of them finish, and pass only if each one
# passed. `gh pr checks --watch` on its own can report green while a slower
# workflow has not even registered its check yet.
#   ./scripts/watch-required-checks.sh <pr-number-or-url>
set -euo pipefail
pr=${1:?usage: watch-required-checks.sh <pr-number-or-url>}

base=$(gh pr view "$pr" --json baseRefName --jq .baseRefName)
required=$(gh api "repos/{owner}/{repo}/rules/branches/$base" \
  --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | unique | .[]')
if [ -z "$required" ]; then
  echo "no ruleset requires a check on $base — watching every check instead"
  exec gh pr checks "$pr" --watch
fi
echo "required on $base: $(tr '\n' ' ' <<<"$required")"

bucket_of() { # bucket_of <check-name> → pass | fail | pending | skipping | cancel | absent
  gh pr checks "$pr" --json name,bucket 2>/dev/null |
    jq -r --arg name "$1" '[.[] | select(.name == $name) | .bucket] as $b
      | if ($b | length) == 0 then "absent"
        elif all($b[]; . == "pass") then "pass"
        elif any($b[]; . == "fail" or . == "cancel") then "fail"
        else "pending" end'
}

for attempt in $(seq 1 180); do # 180 × 10 s = 30 min; raise it if your CI is slower
  waiting='' failed=''
  while IFS= read -r check; do
    case "$(bucket_of "$check")" in
      pass) ;;
      fail) failed="$failed $check" ;;
      *) waiting="$waiting $check" ;;
    esac
  done <<<"$required"
  if [ -n "$failed" ]; then
    echo "REFUSED — required checks failed:$failed" >&2
    exit 1
  fi
  if [ -z "$waiting" ]; then
    echo "every required check passed"
    exit 0
  fi
  echo "waiting ($attempt/180):$waiting"
  sleep 10
done
echo "REFUSED — required checks never finished:$waiting" >&2
exit 1
