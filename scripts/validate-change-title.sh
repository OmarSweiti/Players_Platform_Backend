#!/usr/bin/env bash
# The ONE grammar for commit subjects and squash-merge PR titles. A squash
# merge commits the PR *title*, so both must obey the same rule — and both are
# checked by this one file (commit-msg hook, CI, `just pr`, `just merge`).
#
#   <type>(<scope>): <summary>  [<ref>]
#
#   ./scripts/validate-change-title.sh --validate  '<title>'
#   ./scripts/validate-change-title.sh --normalize '<title>'   # Dependabot titles
#   ./scripts/validate-change-title.sh --self-test
set -euo pipefail

# ── EDIT FOR YOUR PROJECT ───────────────────────────────────────────────────
# Both lists are CLOSED on purpose: a typo'd scope is refused, never invented.
TYPES='feat|fix|test|docs|chore|refactor|perf'
# The product domains (the same words as the frontend, so one change reads
# the same in both repositories), then: common = cross-cutting decorators,
# guards, filters, interceptors, pipes · infra = Prisma service, mail,
# storage, events, config, health, bootstrap · db = Prisma schema, migrations,
# seed · repo = workspace, CI, gates, tooling · docs.
SCOPES='auth|users|players|contracts|medical|scouting|training|legal|chat|notifications|common|infra|db|repo|docs'
# The tag after the summary — delete the alternatives you do not use:
#   —            (em dash) work with no tracked item
#   #123         an issue
#   1.3.4        a plan step · 1.3.4a a split step · 1.3.4–1.3.6 an en-dash range
REF='—|#[0-9]+|[0-9]+\.[0-9]+\.[0-9]+[a-z]?(–[0-9]+\.[0-9]+\.[0-9]+[a-z]?)?'
MAX_SUBJECT=72
# ────────────────────────────────────────────────────────────────────────────

GRAMMAR="^($TYPES)\\(($SCOPES)\\): ([^[:space:]].*[^[:space:]]|[^[:space:]])[[:space:]]+\\[($REF)\\][[:space:]]*$"
TAG_AT_END="[[:space:]]\\[($REF)\\][[:space:]]*$"

usage() {
  echo "usage: $0 --validate '<title>' | --normalize '<title>' | --self-test" >&2
  exit 2
}

refuse() { # refuse <reason> <title>
  {
    printf 'title-policy: REFUSED — %s\n\n' "$1"
    printf '  <type>(<scope>): <summary>  [<ref>]\n'
    printf '  type  ∈ %s\n' "${TYPES//|/ }"
    printf '  scope ∈ %s\n' "${SCOPES//|/ }"
    printf '  ref   = — | #N | N.N.N | N.N.Nx | N.N.N–N.N.N\n\n'
    printf '  got:  %s\n' "${2:-<empty>}"
  } >&2
  return 1
}

validate() {
  local title=$1 subject summary
  case "$title" in
    *$'\n'* | *$'\r'*) refuse "the title must be exactly one line." "$title"; return 1 ;;
  esac
  if ! [[ "$title" =~ $GRAMMAR ]]; then
    refuse "use the complete type(scope): summary  [ref] form." "$title"
    return 1
  fi
  summary=${BASH_REMATCH[3]}
  subject="${BASH_REMATCH[1]}(${BASH_REMATCH[2]}): $summary"
  if [ "${#subject}" -gt "$MAX_SUBJECT" ]; then
    refuse "the subject before the tag is ${#subject} characters; the limit is $MAX_SUBJECT." "$title"
    return 1
  fi
  case "$summary" in
    *.) refuse "do not end the summary with a period." "$title"; return 1 ;;
  esac
}

truncate_words() { # truncate_words <text> <max> — cut at a word boundary, no dangling connective
  local text=$1 max=$2 out='' word candidate last
  local -a words
  read -r -a words <<<"$text"
  for word in ${words[@]+"${words[@]}"}; do
    candidate=${out:+$out }$word
    [ "${#candidate}" -le "$max" ] || break
    out=$candidate
  done
  while [ -n "$out" ]; do
    case "$out" in
      *[[:punct:]] | *[[:space:]]) out=${out%?}; continue ;;
    esac
    last=$(printf '%s' "${out##* }" | tr '[:upper:]' '[:lower:]')
    case "$last" in
      a | an | and | as | at | but | by | for | from | in | into | of | on | or | the | to | via | with | without | across)
        if [[ "$out" == *' '* ]]; then out=${out% *}; else out=''; fi ;;
      *) break ;;
    esac
  done
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# Dependabot cannot be told to append a [ref] tag, and it appends transport
# detail ("in the x group across 1 directory with 5 updates"). This rewrites
# such a title into the grammar; the labeler workflow applies the result.
normalize() {
  local input=$1 candidate prefix summary ref max normalized
  local dir_re='[[:space:]]+across[[:space:]]+[0-9]+[[:space:]]+director(y|ies)([[:space:]]+with[[:space:]]+[0-9]+[[:space:]]+updates?)?$'
  local group_re='[[:space:]]+in[[:space:]]+the[[:space:]]+[^[:space:]]+[[:space:]]+group$'
  if validate "$input" >/dev/null 2>&1; then
    printf '%s\n' "$input"
    return 0
  fi
  case "$input" in
    *$'\n'* | *$'\r'*) validate "$input"; return 1 ;;
  esac
  candidate=$input
  if ! [[ "$candidate" =~ $TAG_AT_END ]]; then
    candidate="$candidate  [—]"
  fi
  if ! [[ "$candidate" =~ $GRAMMAR ]]; then
    validate "$candidate"
    return 1
  fi
  prefix="${BASH_REMATCH[1]}(${BASH_REMATCH[2]}): "
  summary=${BASH_REMATCH[3]}
  ref=${BASH_REMATCH[4]}
  if [[ "$summary" =~ $dir_re ]]; then
    summary=${summary%"${BASH_REMATCH[0]}"}
  fi
  if [ $((${#prefix} + ${#summary})) -gt "$MAX_SUBJECT" ] && [[ "$summary" =~ $group_re ]]; then
    summary=${summary%"${BASH_REMATCH[0]}"}
  fi
  if [ $((${#prefix} + ${#summary})) -gt "$MAX_SUBJECT" ]; then
    max=$((MAX_SUBJECT - ${#prefix}))
    if ! summary=$(truncate_words "$summary" "$max"); then
      refuse "the summary cannot be shortened at a word boundary." "$input"
      return 1
    fi
  fi
  normalized="$prefix$summary  [$ref]"
  validate "$normalized" || return 1
  printf '%s\n' "$normalized"
}

self_test() {
  local pass=0 fail=0
  expect() { # expect <exit> <label> <title>
    local want=$1 label=$2 got=0
    validate "$3" >/dev/null 2>&1 || got=$?
    if [ "$got" -eq "$want" ]; then printf '  ok      %s\n' "$label"; pass=$((pass + 1))
    else printf '  FAILED  %s (wanted %s, got %s)\n' "$label" "$want" "$got"; fail=$((fail + 1)); fi
  }
  normalizes() { # normalizes <expected> <label> <input>
    local want=$1 label=$2 got='' status=0
    got=$(normalize "$3" 2>/dev/null) || status=$?
    if [ "$status" -eq 0 ] && [ "$got" = "$want" ]; then printf '  ok      %s\n' "$label"; pass=$((pass + 1))
    else printf '  FAILED  %s (got "%s", exit %s)\n' "$label" "$got" "$status"; fail=$((fail + 1)); fi
  }

  # The cases use the first scope of the EDIT block, so editing SCOPES never
  # breaks the self-test. `repo` must stay in every scope list.
  local s=${SCOPES%%|*}
  echo "title policy — accepted"
  expect 0 "an issue reference" "feat($s): add the login endpoint  [#42]"
  expect 0 "no tracked item" 'docs(repo): explain the release flow  [—]'
  expect 0 "a plan step" "fix($s): stop rounding twice in the discount path  [1.3.4]"
  expect 0 "a split step" "feat($s): the first half of the checkout  [1.3.4a]"
  expect 0 "an en-dash range" 'chore(repo): land both halves  [1.3.4a–1.3.4b]'
  echo "title policy — refused"
  expect 1 "no tag" "feat($s): add the login endpoint"
  expect 1 "an arbitrary tag" "feat($s): add the login endpoint  [soon]"
  expect 1 "an ASCII-hyphen range" "feat($s): add the login endpoint  [1.3.4-1.3.5]"
  expect 1 "an unknown type" "build($s): add the login endpoint  [#42]"
  expect 1 "an unknown scope" 'feat(agent): add the login endpoint  [#42]'
  expect 1 "a missing scope" 'feat: add the login endpoint  [#42]'
  expect 1 "a trailing period" "feat($s): add the login endpoint.  [#42]"
  expect 1 "an empty summary" "feat($s):   [#42]"
  expect 1 "two lines" "feat($s): add login  [#42]"$'\nsecond line'
  expect 1 "an overlong subject" "feat($s): $(printf 'x%.0s' $(seq 1 70))  [#42]"
  echo "title policy — Dependabot normalization"
  normalizes 'chore(repo): bump vite from 8.2.1 to 8.2.2 in the js-patch group  [—]' \
    "a missing tag is added" 'chore(repo): bump vite from 8.2.1 to 8.2.2 in the js-patch group'
  normalizes 'chore(repo): bump the actions group  [—]' \
    "directory transport detail is removed" 'chore(repo): bump the actions group across 1 directory with 5 updates'
  normalizes 'chore(repo): bump @vitejs/plugin-react from 6.0.5 to 6.1.0  [—]' \
    "the group suffix goes only when the subject is too long" \
    'chore(repo): bump @vitejs/plugin-react from 6.0.5 to 6.1.0 in the js-minor group across 1 directory'
  normalizes 'chore(repo): bump the Rust patch group  [—]' \
    "a conforming title is unchanged" 'chore(repo): bump the Rust patch group  [—]'
  if normalize $'chore(repo): bump x\nmalicious second line' >/dev/null 2>&1; then
    printf '  FAILED  a multi-line title is refused\n'; fail=$((fail + 1))
  else printf '  ok      a multi-line title is refused\n'; pass=$((pass + 1)); fi

  printf '\n%s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --validate) [ "$#" -eq 2 ] || usage; validate "$2" ;;
  --normalize) [ "$#" -eq 2 ] || usage; normalize "$2" ;;
  --self-test) [ "$#" -eq 1 ] || usage; self_test ;;
  *) usage ;;
esac
