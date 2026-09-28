# Backend — Sodara Players Platform

The NestJS API, worker and realtime processes, and the Prisma schema. **The plan lives in the umbrella
repository**, not here:

- inside `Players_Platform/backend/`: read `../AGENTS.md`, then the frontier in
  `../docs/implementation/README.md`;
- in a standalone clone: clone https://github.com/OmarSweiti/Players_Platform with
  `--recurse-submodules` and work from its root.

Before editing, read `../.claude/rules/backend.md`, `../.claude/rules/security.md`, and for schema work
`../.claude/rules/migrations.md`. Gates: `just check`, `just migrations`, and `just test-int` /
`just test-e2e` for the area you changed. Titles carry the microstep ID; no assistant attribution.
