#!/usr/bin/env bash
# Print the `type:` label a PR title earns; print nothing for a free-text title
# (promotions, back-merges, hotfixes). The type is the first word of the title —
# a closed list the title check already enforces — never a guess from paths.
#   ./scripts/pr-type-label.sh --label '<pr title>'
#   ./scripts/pr-type-label.sh --self-test
set -euo pipefail

# Read the closed type list from the validator so the two can never drift.
TYPES=$(sed -n "s/^TYPES='\\(.*\\)'\$/\\1/p" "$(dirname "$0")/validate-change-title.sh")
[ -n "$TYPES" ] || { echo "pr-type-label: cannot read TYPES from validate-change-title.sh" >&2; exit 2; }

label_for() {
  local re="^($TYPES)\\("
  if [[ "$1" =~ $re ]]; then printf 'type: %s\n' "${BASH_REMATCH[1]}"; fi
}

self_test() {
  local pass=0 fail=0
  expect() { # expect <label|-> <title>
    local want=$1 got
    [ "$want" = - ] && want=''
    got=$(label_for "$2")
    if [ "$got" = "$want" ]; then printf '  ok      %-12s <- %s\n' "${want:-(none)}" "$2"; pass=$((pass + 1))
    else printf '  FAILED  wanted %s, got %s <- %s\n' "${want:-(none)}" "${got:-(none)}" "$2"; fail=$((fail + 1)); fi
  }
  expect 'type: feat' 'feat(api): add login  [#42]'
  expect 'type: fix' 'fix(db): stop double rounding  [—]'
  expect 'type: docs' 'docs(repo): explain the flow  [—]'
  expect - 'promote development to staging'
  expect - 'build(api): not a legal type  [—]'
  printf '\n%s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --label) [ "$#" -eq 2 ] || exit 2; label_for "$2" ;;
  --self-test) [ "$#" -eq 1 ] || exit 2; self_test ;;
  *) echo "usage: $0 --label '<title>' | --self-test" >&2; exit 2 ;;
esac
