# Sadara — backend

The API, worker and realtime processes of the Sadara player-management platform: NestJS 11, Prisma 7,
PostgreSQL 18, S3-compatible object storage and Valkey. Part of
[Players_Platform](https://github.com/OmarSweiti/Players_Platform), which holds the plan, the local stack
and the progress record — **start there**.

```bash
git clone --recurse-submodules git@github.com:OmarSweiti/Players_Platform.git
cd Players_Platform && just setup-all && just up          # the whole local stack
cd backend && cp .env.example .env && just migrate && npm run start:dev   # https://sadara.localhost/api/v1
```

| Command | Does |
|---|---|
| `just check` | Prisma validate and generate, build, unit tests — what CI's required `test` check runs |
| `just test-int` · `just test-e2e` | integration and API tests on a real PostgreSQL |
| `just migrations` | replay every migration on a throwaway PostgreSQL 18; no drift allowed |
| `just pr '<title>'` · `just merge <URL>` | ship a change through the flow — see `CONTRIBUTING.md` |

How to work here: `AGENTS.md`. How changes ship: `CONTRIBUTING.md`. Reporting a vulnerability:
`SECURITY.md`.
