#!/usr/bin/env bash
# Refuse a change that breaks the API contract of <base-rev> (ADR-0010): a
# removed route, a newly required input, a narrowed response. A breaking
# change gets a new version of its route beside the old one, or a reviewed
# exception: a line of openapi/breaking-changes.allowed AS <base-rev> HAS IT,
# so the change that needs the exception can never grant it to itself —
# the exception merges first, in a pull request of its own. A line names the
# method, the path and the change, as oasdiff reports them:
#   GET /api/v1/players/{id} removed the success response with the status '200'
#
#   ./scripts/check-breaking-contract.sh <base-rev>
#   ./scripts/check-breaking-contract.sh --self-test
set -euo pipefail

readonly CONTRACT=openapi/openapi.json
readonly ALLOWED=openapi/breaking-changes.allowed
here="$(cd "$(dirname "$0")" && pwd)"

check() {
  local base=$1 work oasdiff
  if ! git cat-file -e "$base:$CONTRACT" 2>/dev/null; then
    echo "contract: $base has no $CONTRACT yet; nothing to break"
    return 0
  fi
  work=$(mktemp -d "${TMPDIR:-/tmp}/contract.XXXXXX")
  trap 'rm -rf "$work"' RETURN
  git show "$base:$CONTRACT" >"$work/base.json"
  local args=(breaking "$work/base.json" "$CONTRACT" --fail-on ERR)
  if git cat-file -e "$base:$ALLOWED" 2>/dev/null; then
    git show "$base:$ALLOWED" >"$work/allowed"
    args+=(--err-ignore "$work/allowed")
  fi
  oasdiff=$(bash "$here/install-oasdiff.sh")
  if ! "$oasdiff" "${args[@]}"; then
    echo "contract: REFUSED — this breaks $base's contract. Add a new version of the route, or merge an exception to $ALLOWED first." >&2
    return 1
  fi
  echo "contract: nothing breaks $base's contract"
}

self_test() {
  local pass=0 fail=0 tmp base self
  self="$here/$(basename "$0")"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/contract-test.XXXXXX")
  trap 'rm -rf "$tmp"' RETURN
  git -C "$tmp" init -q
  git -C "$tmp" config user.name t
  git -C "$tmp" config user.email t@t
  mkdir -p "$tmp/openapi"
  contract() { # contract <path>… : a contract of these GET routes
    local first=1 path
    printf '{"openapi":"3.1.0","info":{"title":"t","version":"1"},"paths":{'
    for path in "$@"; do
      [ "$first" = 1 ] || printf ','
      first=0
      printf '"%s":{"get":{"responses":{"200":{"description":"OK"}}}}' "$path"
    done
    printf '}}\n'
  }
  commit() { git -C "$tmp" add -A && git -C "$tmp" commit -q --no-verify -m "$1"; }
  git -C "$tmp" commit -q --no-verify --allow-empty -m empty
  local empty
  empty=$(git -C "$tmp" rev-parse HEAD)
  contract /a /b >"$tmp/$CONTRACT"
  commit base
  base=$(git -C "$tmp" rev-parse HEAD)
  expect() { # expect <exit> <label> <base-rev> <shell-action>
    local want=$1 label=$2 rev=$3 got=0
    git -C "$tmp" reset -q --hard "$base"
    (cd "$tmp" && eval "$4") >/dev/null 2>&1
    (cd "$tmp" && bash "$self" "$rev") >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then printf '  ok      %s\n' "$label"; pass=$((pass + 1))
    else printf '  FAILED  %s (wanted %s, got %s)\n' "$label" "$want" "$got"; fail=$((fail + 1)); fi
  }
  echo "breaking contract changes"
  expect 0 "an unchanged contract" "$base" ":"
  expect 0 "a new route" "$base" "contract /a /b /c > $CONTRACT"
  expect 1 "a removed route" "$base" "contract /a > $CONTRACT"
  expect 0 "a base with no contract yet" "$empty" "contract /a > $CONTRACT"
  expect 1 "an exception the change grants itself" "$base" \
    "contract /a > $CONTRACT; echo 'GET /b api path removed without deprecation' > $ALLOWED"
  git -C "$tmp" reset -q --hard "$base"
  echo 'GET /b api path removed without deprecation' >"$tmp/$ALLOWED"
  commit exception
  base=$(git -C "$tmp" rev-parse HEAD)
  expect 0 "an exception the base already holds" "$base" "contract /a > $CONTRACT"
  expect 1 "an exception that names another change" "$base" "contract /b > $CONTRACT"
  printf '\n%s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --self-test) self_test ;;
  '' | -*)
    echo "usage: $0 <base-rev> | --self-test" >&2
    exit 2
    ;;
  *) check "$1" ;;
esac
