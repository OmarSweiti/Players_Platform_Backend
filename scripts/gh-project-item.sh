#!/usr/bin/env bash
# File a pull request, or a microstep's issue, on the delivery board
# (docs/implementation/03-github-workflow.md, "The board"), or bring its card
# up to date. Every value comes from what the item already says about itself:
#
#   Status     In Progress while open; Done once merged (a pull request) or
#              closed (an issue). A pull request closed without merging is
#              refused: it has no outcome to track.
#   Phase      the step's phase: [1.2.4] is "1 MVP"
#   Stage      the step's stage in the umbrella's demo milestone, else
#              "after the demo"
#   Group      1.2 — a range across groups is "0.1–0.2"
#   Microstep  the step as written: 1.2.4, 0.4.2b, 0.1.1–0.1.3
#   Risk       the most consequential `risk:` label, or "none" once the
#              labeler has labelled it at all
#   Priority   its `priority:` label, when it has one
#   Blocked    its `needs:` label, else "not blocked"
#
# The step is the title's [ref] on a pull request — [—] and [#12] name none —
# and the title's start on a microstep's issue ("0.5.1 — The Keycloak realm
# as code"). A field it has no value for is left as it is, never cleared.
# Only pull requests into development are cards: a promotion carries work
# whose cards exist.
#
#   ./scripts/gh-project-item.sh <pull request or issue URL | PR number>
#   ./scripts/gh-project-item.sh --sync        # every PR into development, and every microstep issue
#   ./scripts/gh-project-item.sh --self-test
#
# It runs as the maintainer's own login, which needs the `project` scope
# (gh auth refresh -s project,read:project). The board holds status and is
# never a gate: `just pr` and `just merge` warn, and go on, when it fails.
set -euo pipefail

readonly OWNER=OmarSweiti
readonly TITLE='Sadara delivery'
readonly UMBRELLA=OmarSweiti/Players_Platform
readonly MILESTONE=docs/implementation/demo-milestone.md

# stdin: {"item": {kind, title, state, base, labels: [name…]},
#         "fields": [{id, name, dataType, options: [{id, name}…]}…],
#         "stages": {"<step>": "<stage letter>"…}}
# stdout: {"summary": "…", "updates": [{field, value}…]} or {"refused": "<reason>"}
card() {
  jq -c '
    def step: "[0-9]+\\.[0-9]+\\.[0-9]+[a-z]?";
    def refuse($why): error($why);
    def option($fields; $name; matches): # the option of field $name whose name `matches`
      ([$fields[] | select(.name == $name)][0] // refuse("the board has no \($name) field: run the umbrella'"'"'s just gh-project")) as $field
      | ([$field.options[] | select(.name | matches)][0]
          // refuse("the board'"'"'s \($name) field has no option for this card: run the umbrella'"'"'s just gh-project"))
      | {field: $field.id, value: {singleSelectOptionId: .id}, shown: .name};
    def text($fields; $name; $value):
      ([$fields[] | select(.name == $name)][0] // refuse("the board has no \($name) field: run the umbrella'"'"'s just gh-project"))
      | {field: .id, value: {text: $value}, shown: $value};
    .item as $item | .fields as $fields | .stages as $stages
    | try (
        (if $item.kind == "pr" then
           if $item.base != "development" then refuse("it targets \($item.base): a promotion carries work whose cards exist")
           elif $item.state == "CLOSED" then refuse("it was closed without merging: it has no outcome to track")
           else . end
         else . end)
        | ($item.title | if $item.kind == "pr"
            then (capture("\\[(?<ref>\(step)(–\(step))?)\\]\\s*$") // null)
            else (capture("^(?<ref>\(step)) — ") // null) end
          | if . then .ref else null end) as $ref
        | ($ref // "" | split("–") | map(select(length > 0))) as $ends
        | ($item.labels // []) as $labels
        | [ option($fields; "Status"; . == (if $item.state == "OPEN" then "In Progress" else "Done" end)) ]
          + (if $ref then
               ($ends[0] | split(".")) as $first
               | ($ends | map(split(".")[0:2] | join(".")) | unique) as $groups
               | ($stages[$ends[0]] // $stages[$ends[0] | sub("[a-z]$"; "")]) as $stage
               | [ option($fields; "Phase"; startswith($first[0] + " ")),
                   option($fields; "Stage"; if $stage then startswith($stage + " — ") else . == "after the demo" end),
                   text($fields; "Group"; $groups | join("–")),
                   text($fields; "Microstep"; $ref) ]
             else [] end)
          + (if ($labels | length) > 0 then
               ([("security", "migration", "breaking") as $risk | select($labels | index("risk: " + $risk)) | $risk][0]
                 // "none") as $risk
               | [ option($fields; "Risk"; . == $risk) ]
             else [] end)
          + ([$labels[] | select(startswith("priority: "))][0] as $priority
             | if $priority then [ option($fields; "Priority"; . == ($priority | ltrimstr("priority: "))) ] else [] end)
          + ([$labels[] | select(startswith("needs: "))][0] as $needs
             | [ option($fields; "Blocked"; . == (if $needs then "needs " + ($needs | ltrimstr("needs: ")) else "not blocked" end)) ])
        | {summary: (map(.shown) | join(" · ")), updates: map({field, value})}
      ) catch {refused: .}'
}

board_number() {
  gh project list --owner "$OWNER" --limit 200 --format json |
    jq -r --arg title "$TITLE" '[.projects[] | select(.title == $title) | .number]
      | if length == 1 then .[0] else error("expected one open project named \($title); found \(length): run the umbrella'"'"'s just gh-project") end'
}

board_fields() { # board_fields <number> — {id, number, fields}
  gh api graphql -F owner="$OWNER" -F number="$1" -f query='
    query($owner: String!, $number: Int!) {
      user(login: $owner) { projectV2(number: $number) {
        id
        fields(first: 50) { nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } } } } } } }' \
    --jq '.data.user.projectV2 | {id, number: '"$1"', fields: [.fields.nodes[] | {id, name, dataType, options: (.options // [])}]}'
}

# The demo milestone's stages, read from the umbrella's development, as {"0.1.1": "A", …}.
milestone_stages() {
  gh api "repos/$UMBRELLA/contents/$MILESTONE?ref=development" -H 'Accept: application/vnd.github.raw' |
    sed -n '/<!-- milestone:steps:begin -->/,/<!-- milestone:steps:end -->/p' |
    jq -R -s '[split("\n")[] | capture("^\\| (?<stage>[A-Z]) — [^|]*\\|(?<steps>.*)\\|\\s*$") // empty
      | .stage as $stage | .steps | [scan("`([0-9]+\\.[0-9]+\\.[0-9]+[a-z]?)`")[0] | {key: ., value: $stage}][]]
      | from_entries'
}

# file <board> <stages> <item JSON with url> — add the item, then set every field in one request.
file() {
  local board=$1 stages=$2 item=$3 plan item_id url
  url=$(jq -r .url <<<"$item")
  plan=$(jq -n --argjson item "$item" --argjson board "$board" --argjson stages "$stages" \
    '{item: $item, fields: $board.fields, stages: $stages}' | card)
  if jq -e 'has("refused")' <<<"$plan" >/dev/null; then
    echo "gh-project-item: $url — $(jq -r .refused <<<"$plan")" >&2
    return 3
  fi
  item_id=$(gh project item-add "$(jq -r .number <<<"$board")" --owner "$OWNER" --url "$url" --format json | jq -r .id)
  jq -n --argjson plan "$plan" --arg project "$(jq -r .id <<<"$board")" --arg item "$item_id" '
    $plan.updates | to_entries | {
      query: ("mutation($project: ID!, $item: ID!, "
        + (map("$field\(.key): ID!, $value\(.key): ProjectV2FieldValue!") | join(", ")) + ") { "
        + (map("set\(.key): updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field\(.key), value: $value\(.key)}) { clientMutationId }") | join(" "))
        + " }"),
      variables: ({project: $project, item: $item}
        + (map({("field\(.key)"): .value.field, ("value\(.key)"): .value.value}) | add))}' |
    gh api graphql --input - >/dev/null
  echo "board: $url → $(jq -r .summary <<<"$plan")"
}

pr_json() { gh pr view "$1" --json url,title,state,baseRefName,labels \
  --jq '{kind: "pr", url, title, state, base: .baseRefName, labels: [.labels[].name]}'; }
issue_json() { gh issue view "$1" --json url,title,state,labels \
  --jq '{kind: "issue", url, title, state, labels: [.labels[].name]}'; }

self_test() {
  local pass=0 fail=0 fields stages
  fields=$(jq -n '[
    {id: "S", name: "Status", options: [{id: "s1", name: "Todo"}, {id: "s2", name: "In Progress"}, {id: "s3", name: "Done"}]},
    {id: "P", name: "Phase", options: [{id: "p0", name: "0 Foundation & hardening"}, {id: "p1", name: "1 MVP"}]},
    {id: "T", name: "Stage", options: [{id: "ta", name: "A — Harnesses"}, {id: "td", name: "D — The data foundation"},
                                       {id: "ti", name: "I — Players and documents"}, {id: "tz", name: "after the demo"}]},
    {id: "G", name: "Group", options: []}, {id: "M", name: "Microstep", options: []},
    {id: "R", name: "Risk", options: [{id: "r1", name: "security"}, {id: "r2", name: "migration"}, {id: "r3", name: "breaking"}, {id: "r4", name: "none"}]},
    {id: "Y", name: "Priority", options: [{id: "y0", name: "P0"}, {id: "y1", name: "P1"}]},
    {id: "B", name: "Blocked", options: [{id: "b1", name: "needs answer"}, {id: "b2", name: "needs decision"}, {id: "b3", name: "not blocked"}]}]')
  stages='{"0.1.1": "A", "0.2.3": "A", "0.4.0": "D", "0.4.2": "D", "1.2.4": "I"}'
  item() { # item <kind> <state> <title> [<label>…] — base development
    local kind=$1 state=$2 title=$3
    shift 3
    jq -n --arg kind "$kind" --arg state "$state" --arg title "$title" --args \
      '{kind: $kind, state: $state, title: $title, base: "development", labels: $ARGS.positional}' "$@"
  }
  expect() { # expect <label> <item JSON> <summary, or "refused">
    local label=$1 want=$3 got
    got=$(jq -n --argjson item "$2" --argjson fields "$fields" --argjson stages "$stages" \
      '{item: $item, fields: $fields, stages: $stages}' | card | jq -r 'if has("refused") then "refused" else .summary end')
    if [ "$got" = "$want" ]; then printf '  ok      %s\n' "$label"; pass=$((pass + 1))
    else printf '  FAILED  %s\n          wanted: %s\n          got:    %s\n' "$label" "$want" "$got"; fail=$((fail + 1)); fi
  }
  echo "the card a pull request or a microstep issue gets"
  expect "an open step PR, as soon as it opens" "$(item pr OPEN 'feat(players): add the player directory  [1.2.4]')" \
    "In Progress · 1 MVP · I — Players and documents · 1.2 · 1.2.4 · not blocked"
  expect "a merged step PR, labelled" "$(item pr MERGED 'feat(db): one naming scheme  [0.4.0]' 'type: feat' 'risk: migration')" \
    "Done · 0 Foundation & hardening · D — The data foundation · 0.4 · 0.4.0 · migration · not blocked"
  expect "the most consequential risk wins" "$(item pr OPEN 'feat(auth): x  [0.4.2]' 'risk: breaking' 'risk: security' 'risk: migration')" \
    "In Progress · 0 Foundation & hardening · D — The data foundation · 0.4 · 0.4.2 · security · not blocked"
  expect "a split step takes its parent's stage" "$(item pr OPEN 'feat(db): x  [0.4.2b]')" \
    "In Progress · 0 Foundation & hardening · D — The data foundation · 0.4 · 0.4.2b · not blocked"
  expect "a range across groups" "$(item pr MERGED 'docs(plan): x  [0.1.1–0.2.3]' 'area: plan')" \
    "Done · 0 Foundation & hardening · A — Harnesses · 0.1–0.2 · 0.1.1–0.2.3 · none · not blocked"
  expect "a step outside the demo" "$(item pr OPEN 'feat(medical): x  [1.9.1]')" \
    "In Progress · 1 MVP · after the demo · 1.9 · 1.9.1 · not blocked"
  expect "work outside the plan names no step" "$(item pr MERGED 'chore(repo): bump the npm-patch group  [—]' dependencies)" \
    "Done · none · not blocked"
  expect "an issue reference names no step" "$(item pr OPEN 'fix(auth): x  [#12]')" "In Progress · not blocked"
  expect "priority and a blocking question, from labels" "$(item issue OPEN '0.4.2 — x' 'priority: P0' 'needs: decision')" \
    "In Progress · 0 Foundation & hardening · D — The data foundation · 0.4 · 0.4.2 · none · P0 · needs decision"
  expect "a microstep's issue, closed" "$(item issue CLOSED '1.2.4 — The player directory')" \
    "Done · 1 MVP · I — Players and documents · 1.2 · 1.2.4 · not blocked"
  expect "an issue without a step at its start" "$(item issue OPEN 'Something about 1.2.4')" "In Progress · not blocked"
  expect "a PR closed without merging is refused" "$(item pr CLOSED 'chore(repo): x  [—]')" refused
  expect "a promotion is refused" "$(item pr OPEN 'promote development to staging' | jq '.base = "staging"')" refused
  fields=$(jq 'map(if .name == "Stage" then .options |= map(select(.name != "D — The data foundation")) else . end)' <<<"$fields")
  expect "a stage the board lacks is refused" "$(item pr OPEN 'feat(db): x  [0.4.0]')" refused
  fields=$(jq 'map(select(.name != "Microstep"))' <<<"$fields")
  expect "a board without a field is refused" "$(item pr OPEN 'feat(players): x  [1.2.4]')" refused
  printf '\n%s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --self-test) self_test; exit ;;
  --sync | https://github.com/*/pull/[0-9]* | https://github.com/*/issues/[0-9]*) ;;
  '' | *[!0-9]*) echo "usage: $0 <pull request or issue URL | PR number> | --sync | --self-test" >&2; exit 2 ;;
esac

gh auth status 2>&1 | grep -q "'project'" ||
  { echo "gh-project-item: the login lacks the 'project' scope: run gh auth refresh -s project,read:project" >&2; exit 1; }
board=$(board_fields "$(board_number)")
stages=$(milestone_stages)

if [ "$1" != --sync ]; then
  case "$1" in
    */issues/*) file "$board" "$stages" "$(issue_json "$1")" ;;
    *) file "$board" "$stages" "$(pr_json "$1")" ;;
  esac
  exit
fi

# --sync: everything this repository has put on development, and every microstep's issue.
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
filed=0 skipped=0 failed=0
while IFS= read -r item; do
  status=0
  file "$board" "$stages" "$item" || status=$?
  case "$status" in
    0) filed=$((filed + 1)) ;;
    3) skipped=$((skipped + 1)) ;;
    *) failed=$((failed + 1)) ;;
  esac
  sleep 1 # GitHub limits how fast content may be written
done < <(
  gh pr list --repo "$repo" --base development --state all --limit 1000 \
    --json url,number,title,state,baseRefName,labels \
    --jq 'sort_by(.number)[] | select(.state != "CLOSED")
      | {kind: "pr", url, title, state, base: .baseRefName, labels: [.labels[].name]}'
  gh issue list --repo "$repo" --state all --limit 1000 --json url,number,title,state,labels \
    --jq 'sort_by(.number)[] | select(.title | test("^[0-9]+\\.[0-9]+\\.[0-9]+[a-z]? — "))
      | {kind: "issue", url, title, state, labels: [.labels[].name]}'
)
echo "gh-project-sync: $repo — $filed filed, $skipped refused, $failed failed"
[ "$failed" -eq 0 ]
