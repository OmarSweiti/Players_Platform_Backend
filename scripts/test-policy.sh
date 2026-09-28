#!/usr/bin/env bash
# `just guards` and CI's `guards` job: prove every guard still refuses.
# A guard nobody has seen fail is a guard nobody should trust.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
status=0
run() {
  printf '\n── %s\n' "$*"
  "$@" || status=1
}
run bash scripts/validate-change-title.sh --self-test
run bash scripts/validate-branch-flow.sh --self-test
run bash scripts/check-attribution.sh --self-test
run bash scripts/check-protected-paths.sh --self-test
run bash scripts/pr-type-label.sh --self-test
run bash .githooks/test-hooks.sh
if [ "$status" -eq 0 ]; then echo; echo "guards: every guard still refuses"; else echo; echo "guards: FAILED"; fi
exit "$status"
