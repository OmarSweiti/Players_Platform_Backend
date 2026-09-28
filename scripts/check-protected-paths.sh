#!/usr/bin/env bash
# Refuse a change set that edits, deletes, renames or re-modes a file that
# already existed — at the MERGE BASE — under an immutable prefix. Adding a new
# file there is the legitimate move (write the next migration, not a new past).
#
# Asking the merge base (not the base tip) is what keeps a branch that merely
# fell behind from being accused of deleting a file the base added since, and
# what keeps a promotion PR green.
#
#   ./scripts/check-protected-paths.sh <base-rev> <head-rev>
#   ./scripts/check-protected-paths.sh --self-test
set -euo pipefail

# ── EDIT FOR YOUR PROJECT (keep equal to .githooks/pre-commit) ──────────────
IMMUTABLE_PREFIXES=(
  "prisma/migrations/" # forward-only: never edit a migration once committed; write the next one
  "docs/adr/"        # an accepted decision record is history; supersede it
)
# ────────────────────────────────────────────────────────────────────────────

check() {
  local base=$1 head=$2 merge_base changes status path prefix refused=0
  merge_base=$(git merge-base "$base" "$head") || {
    echo "protected-paths: ERROR — no merge base for $base and $head; refusing closed." >&2
    return 2
  }
  changes=$(mktemp "${TMPDIR:-/tmp}/protected-paths.XXXXXX")
  git diff --name-status --no-renames -z "$merge_base" "$head" >"$changes" || {
    rm -f "$changes"
    echo "protected-paths: ERROR — git diff failed; refusing closed." >&2
    return 2
  }
  while IFS= read -r -d '' status && IFS= read -r -d '' path; do
    [ "$status" = A ] && continue
    for prefix in "${IMMUTABLE_PREFIXES[@]}"; do
      case "$path" in
        "$prefix"*)
          echo "protected-paths: REFUSED — $status $path (immutable once committed; add a new file instead)" >&2
          refused=1 ;;
      esac
    done
  done <"$changes"
  rm -f "$changes"
  [ "$refused" -eq 0 ] && echo "protected-paths: OK"
  return "$refused"
}

self_test() {
  local pass=0 fail=0 tmp base self
  # The cases live under the first prefix of the EDIT block, so editing the
  # list never breaks the self-test.
  local imm=${IMMUTABLE_PREFIXES[0]}
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/protected-paths-test.XXXXXX")
  trap 'rm -rf "$tmp"' RETURN
  git -C "$tmp" init -q
  git -C "$tmp" config user.name t
  git -C "$tmp" config user.email t@t
  mkdir -p "$tmp/$imm"
  echo 'CREATE TABLE a (id int);' >"$tmp/${imm}0001_init.sql"
  echo 'app' >"$tmp/app.txt"
  git -C "$tmp" add -A
  git -C "$tmp" commit -q --no-verify -m base
  base=$(git -C "$tmp" rev-parse HEAD)
  expect() { # expect <exit> <label> <shell-action>
    local want=$1 label=$2 got=0
    git -C "$tmp" reset -q --hard "$base"
    (cd "$tmp" && eval "$3" && git add -A && git commit -q --no-verify -m head) >/dev/null 2>&1
    (cd "$tmp" && bash "$self" "$base" HEAD) >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then printf '  ok      %s\n' "$label"; pass=$((pass + 1))
    else printf '  FAILED  %s (wanted %s, got %s)\n' "$label" "$want" "$got"; fail=$((fail + 1)); fi
  }
  echo "protected paths"
  expect 0 "adding the next file under $imm" "echo 'CREATE TABLE b (id int);' > ${imm}0002_b.sql"
  expect 0 "editing an ordinary file" "echo changed > app.txt"
  expect 1 "editing a committed file under $imm" "echo '-- edit' >> ${imm}0001_init.sql"
  expect 1 "deleting a committed file under $imm" "git rm -q ${imm}0001_init.sql"
  expect 1 "renaming a committed file under $imm" "git mv ${imm}0001_init.sql ${imm}0001_first.sql"
  expect 1 "re-moding a committed file under $imm" "chmod +x ${imm}0001_init.sql"
  printf '\n%s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --self-test) [ "$#" -eq 1 ] || exit 2; self_test ;;
  *) [ "$#" -eq 2 ] || { echo "usage: $0 <base-rev> <head-rev> | --self-test" >&2; exit 2; }; check "$1" "$2" ;;
esac
