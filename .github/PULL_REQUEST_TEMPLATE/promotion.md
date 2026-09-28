## Promotion

**From → to:** `development → staging` (release candidate) · or `staging → main` (production)
**Reviewed base SHA:** `<full 40-character destination tip>`
**Reviewed head SHA:** `<full 40-character source tip>`
**Intended tag:** `<vX.Y.Z-rc.N · vX.Y.Z · n/a>`

## What is in it

<!-- git log --oneline <destination>..<source> -->

## What is deliberately NOT in it

## Evidence

- [ ] `gh pr view <PR> --json baseRefOid,headRefOid` equals both SHAs above
- [ ] every required check passed for exactly that head (`scripts/watch-required-checks.sh <PR>`)
- [ ] re-read both SHAs immediately before merging — any change discards this evidence
- [ ] the smoke test on a fresh environment
- [ ] a restore from backup was actually performed, not merely possible

## Release notes

<!-- Plain sentences a user would understand. -->

## Rollback

<!-- The exact way back. Tags are append-only: a bad build is a new patch, never a moved tag. -->

---

**Merge with a MERGE COMMIT — never squash.** A squash replaces the source
commits with a new one, breaks the shared ancestry this flow depends on, and
makes every later promotion propose the same commits again.
