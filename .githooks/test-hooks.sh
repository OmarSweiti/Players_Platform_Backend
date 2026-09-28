#!/usr/bin/env bash
# A guard nobody has seen fail is a guard nobody should trust.
# Builds a throwaway repository wired to these hooks and proves each one
# refuses what it must — and still allows the legitimate cases.
set -uo pipefail
src=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# The immutable-path cases follow the first prefix of pre-commit's EDIT block,
# and every subject uses the `repo` scope, which every scope list keeps — so
# editing either list never breaks these tests.
imm=$(sed -n '/^IMMUTABLE_PREFIXES=(/,/^)/s/^[[:space:]]*"\([^"]*\)".*/\1/p' "$src/.githooks/pre-commit" | head -n 1)
[ -n "$imm" ] || { echo "test-hooks: cannot read IMMUTABLE_PREFIXES from .githooks/pre-commit" >&2; exit 2; }
tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-hooks.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
pass=0 fail=0 skipped=0
zero=0000000000000000000000000000000000000000
ok() { printf '  ok      %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAILED  %s\n' "$1"; fail=$((fail + 1)); }
skip() { printf '  skipped %s\n' "$1"; skipped=$((skipped + 1)); }
expect() { # expect <exit> <label> <command...>
  local want=$1 label=$2 got=0
  shift 2
  "$@" >/dev/null 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then ok "$label"; else bad "$label (wanted exit $want, got $got)"; fi
}

# A repository with the policy files, a bare remote, and the hooks wired in.
repo="$tmp/repo"
git init -q --bare "$tmp/remote.git"
git init -q -b main "$repo"
mkdir -p "$repo/scripts" "$repo/.githooks" "$repo/$imm"
cp "$src"/scripts/*.sh "$repo/scripts/"
cp "$src"/.githooks/* "$repo/.githooks/"
[ -f "$src/.gitleaks.toml" ] && cp "$src/.gitleaks.toml" "$repo/.gitleaks.toml"
[ -f "$repo/.gitleaks.toml" ] || printf '[extend]\nuseDefault = true\n' >"$repo/.gitleaks.toml"
cd "$repo" || exit 1
git config user.name Dev
git config user.email dev@example.com
git config commit.gpgsign false
git config tag.gpgsign false
git remote add origin "$tmp/remote.git"
echo 'CREATE TABLE a (id int);' >"${imm}0001_init.sql"
git add -A
git commit -q --no-verify -m 'chore(repo): seed  [—]'
git push -q --no-verify origin main 2>/dev/null
git config core.hooksPath .githooks
have_gitleaks=0
command -v gitleaks >/dev/null 2>&1 && have_gitleaks=1

msg() { printf '%s\n' "$1" >"$tmp/msg"; .githooks/commit-msg "$tmp/msg"; }
echo "commit-msg"
expect 0 "a legal subject" msg 'feat(repo): add login  [#42]'
expect 1 "an illegal subject" msg 'added login'
expect 1 "an assistant trailer" msg $'feat(repo): add login  [#42]\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>'
expect 0 "Git's own merge subject" msg "Merge branch 'feat/x' into development"
expect 1 "a merge subject cannot smuggle a trailer" msg $'Merge branch \'x\'\n\nGenerated with Claude Code'
expect 0 "a diff below the scissors is not the message" msg \
  $'feat(repo): add login  [#42]\n# ------------------------ >8 ------------------------\n Co-Authored-By: Claude Code <noreply@anthropic.com>'

try_commit() { # try_commit <message> — commit whatever is staged, hooks on
  git commit -q -m "$1"
}
reset_index() { git reset -q --hard HEAD; git clean -qfdx -e .gitleaks.toml; }
echo "pre-commit"
echo hello >notes.txt && git add notes.txt
expect 0 "an ordinary file" try_commit 'docs(repo): notes  [—]'
reset_index
echo 'SECRET=1' >.env && git add -f .env
expect 1 "a .env file" try_commit 'chore(repo): env  [—]'
reset_index
echo 'SECRET=' >.env.example && git add .env.example
expect 0 "a .env.example template" try_commit 'chore(repo): env template  [—]'
reset_index
head -c 2100000 /dev/zero >big.bin && git add big.bin
expect 1 "an oversized blob" try_commit 'chore(repo): big  [—]'
reset_index
echo '-- edited' >>"${imm}0001_init.sql" && git add "$imm"
expect 1 "an edit to a committed file under $imm" try_commit 'fix(repo): edit history  [—]'
reset_index
echo 'CREATE TABLE b (id int);' >"${imm}0002_b.sql" && git add "$imm"
expect 0 "the next file under $imm" try_commit 'feat(repo): table b  [—]'
reset_index
if [ "$have_gitleaks" -eq 1 ]; then
  printf 'aws_key = "%s"\n' "AK""IAQ7X2M3P4L6R5T3WZ" >config.txt && git add config.txt
  expect 1 "a token in an ordinary file" try_commit 'chore(repo): config  [—]'
  reset_index
else
  skip "a token in an ordinary file (gitleaks not installed)"
fi

push() { # push <local-ref> <local-sha> <remote-ref> <remote-sha>
  printf '%s %s %s %s\n' "$1" "$2" "$3" "$4" | .githooks/pre-push origin "$tmp/remote.git"
}
git fetch -q origin
echo "pre-push"
git switch -q -c feat/login
echo login >login.txt && git add login.txt && git commit -q -m 'feat(repo): add login  [#42]'
sha=$(git rev-parse HEAD)
expect 0 "a clean feature branch" push refs/heads/feat/login "$sha" refs/heads/feat/login "$zero"
expect 1 "a direct push to development" push refs/heads/development "$sha" refs/heads/development "$zero"
main_sha=$(git rev-parse origin/main)
unrelated=$(git commit-tree "$(git hash-object -t tree /dev/null)" -m 'rewritten history' </dev/null)
expect 1 "a force push to main" push refs/heads/main "$unrelated" refs/heads/main "$main_sha"
expect 1 "deleting main" push "(delete)" "$zero" refs/heads/main "$main_sha"
git commit -q --no-verify --allow-empty -m $'feat(repo): more  [#42]\n\nCo-Authored-By: Claude Opus 4 <noreply@anthropic.com>'
expect 1 "a pushed commit with an assistant trailer" push refs/heads/feat/login "$(git rev-parse HEAD)" refs/heads/feat/login "$zero"
git reset -q --hard "$sha"
if [ "$have_gitleaks" -eq 1 ]; then
  printf 'aws_key = "%s"\n' "AK""IAZ5W2N6C3V7B2K4QD" >leak.txt && git add leak.txt && git commit -q --no-verify -m 'chore(repo): leak  [—]'
  expect 1 "a pushed commit with a secret" push refs/heads/feat/login "$(git rev-parse HEAD)" refs/heads/feat/login "$zero"
  git reset -q --hard "$sha"
else
  skip "a pushed commit with a secret (gitleaks not installed)"
fi
git tag lightweight-ok "$sha"
expect 0 "a new non-release tag" push refs/tags/lightweight-ok "$sha" refs/tags/lightweight-ok "$zero"
expect 1 "moving an existing tag" push refs/tags/v1.0.0 "$sha" refs/tags/v1.0.0 "$main_sha"
expect 1 "deleting an existing tag" push "(delete)" "$zero" refs/tags/v1.0.0 "$main_sha"
git tag v1.0.0 "$sha"
expect 1 "a lightweight release tag" push refs/tags/v1.0.0 "$sha" refs/tags/v1.0.0 "$zero"
git tag -d v1.0.0 >/dev/null
git tag -a v1.0.0 -m 'unsigned' "$sha"
expect 1 "an unsigned annotated release tag" push refs/tags/v1.0.0 "$(git rev-parse v1.0.0)" refs/tags/v1.0.0 "$zero"
git tag -a v01.0.0 -m 'bad grammar' "$sha"
expect 1 "a malformed release tag" push refs/tags/v01.0.0 "$(git rev-parse v01.0.0)" refs/tags/v01.0.0 "$zero"
if command -v ssh-keygen >/dev/null 2>&1; then
  ssh-keygen -q -t ed25519 -N '' -f "$tmp/signing" >/dev/null
  git config gpg.format ssh
  git config user.signingkey "$tmp/signing.pub"
  git tag -s v1.0.1 -m 'signed' "$sha" 2>/dev/null
  expect 0 "a signed annotated release tag" push refs/tags/v1.0.1 "$(git rev-parse v1.0.1)" refs/tags/v1.0.1 "$zero"
else
  skip "a signed annotated release tag (ssh-keygen not available)"
fi

printf '\n%s passed, %s failed, %s skipped\n' "$pass" "$fail" "$skipped"
[ "$fail" -eq 0 ]
