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

## Validation

<!-- The change running, seen working: the stack and the apps started from this
     head, each scenario exercised — a screen in Arabic and in English — with
     what was expected and what was seen. The evidence (screenshots, request
     transcripts) is the validation comment `just evidence` posts for the head
     commit; the `validation` check refuses the PR without it. A change that
     runs nothing (plan text) says so and shows the rendered result. -->

## Not in this PR

<!-- Scope a reviewer will look for and not find, and where it is tracked. -->

---

- [ ] the local gate is green (`just pre-push`)
- [ ] I read my own diff in the GitHub UI, after a break
- [ ] validation evidence is posted for the head commit: run, exercised, screenshots
- [ ] the title is `type(scope): summary  [ref]` — it becomes the squash commit
- [ ] base branch is `development` (only a promotion targets `staging` or `main`)
- [ ] docs this change contradicts are fixed in this same PR
- [ ] no secret, credential or personal data is reachable from a log, an error, or a fixture
