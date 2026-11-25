# Integration Hub

A hub that takes pharmacy events from a hospital's source system and delivers them to SATUSEHAT (HL7 FHIR R4), so that each visit's effects land exactly once and in order. Domain terms are in [GLOSSARY.md](GLOSSARY.md); decisions are in [docs/adr](docs/adr).

## Run it from a clean clone

You need Node 24 (see `.nvmrc`), pnpm 11 (`corepack enable` picks up the pinned version), and Docker.

```sh
pnpm install        # install workspace dependencies
pnpm deps:up        # start Postgres and Redis (compose), wait until healthy
pnpm migrate        # one-shot: apply database migrations
pnpm test           # run the full suite against the real Postgres and Redis
```

To run the hub service itself:

```sh
pnpm build
node apps/hub/dist/main.js     # serves GET http://localhost:3000/livez
```

`pnpm deps:down` stops the containers and deletes their data.

Defaults match `compose.yaml`, so no `.env` is needed. If ports 5432 or 6379 are taken, start compose with `POSTGRES_PORT`/`REDIS_PORT` and point the hub and tests at them with `DATABASE_URL`/`REDIS_URL` (see `.env.example`).

The hub never migrates itself: always run `pnpm migrate` before starting it. The test suite runs the same migrations in its global setup.

## Repository layout

| Path | What |
|---|---|
| `apps/hub` | The hub: one NestJS + Fastify codebase, deployed as the hub service and (later) the worker process (ADR 0001) |
| `compose.yaml` | Local infrastructure; only components from the closed list |
| `.github/workflows/ci.yml` | CI: the same `pnpm test` against Postgres and Redis service containers |

Later: `packages/mock-satusehat`, `packages/simulator`, `apps/dashboard`.
