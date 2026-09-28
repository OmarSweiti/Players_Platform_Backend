#!/usr/bin/env bash
# One fail-closed grammar for PR branch names and head → base topology.
#
#   feature branch → development → staging → main      (and hotfix/* → main)
#
#   ./scripts/validate-branch-flow.sh <head-ref> <base-ref> <head-repo> <base-repo>
#   ./scripts/validate-branch-flow.sh --self-test
set -euo pipefail

# ── EDIT FOR YOUR PROJECT ───────────────────────────────────────────────────
# Work branches are <prefix>/<kebab-slug> and always target development.
WORK_PREFIXES='feat|fix|chore|docs|refactor|perf|test'
# ────────────────────────────────────────────────────────────────────────────

usage() {
  echo "usage: $0 <head-ref> <base-ref> <head-repo> <base-repo> | --self-test" >&2
  exit 2
}

refuse() {
  echo "branch-policy: REFUSED — $1" >&2
  return 1
}

validate() {
  local head=$1 base=$2 head_repo=$3 base_repo=$4
  local kebab='^[a-z0-9]+(-[a-z0-9]+)*$'
  local work="^($WORK_PREFIXES)/[a-z0-9]+(-[a-z0-9]+)*$"
  local release='^chore/release-v[0-9]+\.[0-9]+\.[0-9]+$'
  local bot='^dependabot/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'

  [ -n "$head" ] && [ -n "$base" ] && [ -n "$head_repo" ] && [ -n "$base_repo" ] || {
    refuse "head, base and both repositories are required."
    return 1
  }
  # Promotions, back-merges and hotfixes never come from a fork.
  case "$head" in
    development | staging | main | hotfix/*)
      [ "$head_repo" = "$base_repo" ] || { refuse "$head must come from $base_repo, not $head_repo."; return 1; } ;;
  esac

  case "$head" in
    development)
      [ "$base" = staging ] || { refuse "development promotes to staging, never to '$base'."; return 1; } ;;
    staging)
      case "$base" in
        main | development) ;; # promotion, or the hotfix back-merge
        *) refuse "staging promotes to main (or back-merges to development), never to '$base'."; return 1 ;;
      esac ;;
    main)
      [ "$base" = staging ] || { refuse "main only back-merges a hotfix into staging, never into '$base'."; return 1; } ;;
    hotfix/*)
      [[ "${head#hotfix/}" =~ $kebab ]] || { refuse "hotfix branches are hotfix/<kebab-slug>."; return 1; }
      [ "$base" = main ] || { refuse "a hotfix targets main; ordinary fixes are fix/<slug> into development."; return 1; } ;;
    dependabot/*)
      [[ "$head" =~ $bot ]] || { refuse "Dependabot branch components must be path-safe."; return 1; }
      [ "$base" = development ] || { refuse "Dependabot merges into development, not '$base'."; return 1; } ;;
    *)
      if [[ "$head" =~ $release ]] || [[ "$head" =~ $work ]]; then
        [ "$base" = development ] || { refuse "work branches merge into development, not '$base'."; return 1; }
      else
        refuse "'$head' is outside the branch scheme: ${WORK_PREFIXES//|/, } + /<kebab-slug>, hotfix/<slug>, chore/release-vX.Y.Z."
        return 1
      fi ;;
  esac
  echo "branch topology OK: $head_repo:$head -> $base_repo:$base"
}

self_test() {
  local pass=0 fail=0
  expect() { # expect <exit> <label> <head> <base> [head-repo]
    local want=$1 label=$2 got=0
    validate "$3" "$4" "${5:-me/app}" "me/app" >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then printf '  ok      %s\n' "$label"; pass=$((pass + 1))
    else printf '  FAILED  %s (wanted %s, got %s)\n' "$label" "$want" "$got"; fail=$((fail + 1)); fi
  }
  echo "branch policy — legal routes"
  expect 0 "a feature branch" feat/login-page development
  expect 0 "a fix branch" fix/receipt-rounding development
  expect 0 "a fork's work branch" fix/typo development fork/app
  expect 0 "a release-preparation chore" chore/release-v1.2.0 development
  expect 0 "a nested Dependabot branch" dependabot/npm_and_yarn/vite-8.2.1 development
  expect 0 "development promotes to staging" development staging
  expect 0 "staging promotes to main" staging main
  expect 0 "staging back-merges a hotfix" staging development
  expect 0 "main back-merges a hotfix" main staging
  expect 0 "a hotfix targets main" hotfix/total-drift main
  echo "branch policy — refused"
  expect 1 "an unknown prefix" wip/login development
  expect 1 "an empty slug" fix/ development
  expect 1 "a non-kebab slug" fix/Receipt_Rounding development
  expect 1 "a work branch targeting staging" feat/login staging
  expect 1 "a work branch targeting main" feat/login main
  expect 1 "development skipping staging" development main
  expect 1 "a hotfix targeting development" hotfix/total-drift development
  expect 1 "a promotion from a fork" development staging fork/app
  expect 1 "a release/* branch (no GitFlow)" release/v1.2.0 development
  printf '\n%s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --self-test) [ "$#" -eq 1 ] || usage; self_test ;;
  *) [ "$#" -eq 4 ] || usage; validate "$1" "$2" "$3" "$4" ;;
esac
