## Closes

<!-- `Closes #123`, one per line — or "none" and why. Only a closing keyword
     closes the issue (and moves its board card) on merge. -->

## What

<!-- The unit of work this lands, in one or two sentences. -->

## Why now

<!-- One sentence: what was blocked without it. -->

## Risk

<!-- What this could break, and which invariant or contract it touches.
     "None" is a legitimate answer for a docs or chore PR. -->

## Verification

<!-- Commands and their results — not "tests pass".
     - `<test command>` — 14 tests
     - Manual: what you did, on a fresh environment, and what you saw. -->

## Not in this PR

<!-- Scope a reviewer will look for and not find, and where it is tracked. -->

---

- [ ] the local gate is green (`just pre-push`)
- [ ] I read my own diff in the GitHub UI, after a break
- [ ] the title is `type(scope): summary  [ref]` — it becomes the squash commit
- [ ] base branch is `development` (only a promotion targets `staging` or `main`)
- [ ] docs this change contradicts are fixed in this same PR
- [ ] no secret, credential or personal data is reachable from a log, an error, or a fixture
