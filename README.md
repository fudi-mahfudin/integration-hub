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
node apps/hub/dist/worker-main.js   # claims steps and sends them to SATUSEHAT (default: the mock on :4010)
```

The HTTP API (events, cases, error codes, idempotency key retention) is specified in [docs/api.md](docs/api.md). Without `HUB_SOURCES` the hub registers one development source system, `simulator`, with the public key `dev-source-key`; set `HUB_SOURCES` to a JSON array of `{ id, organizationId, apiKey }` anywhere else. Location mappings (source, local `locationCode` → SATUSEHAT Location) come from `apps/hub/seed/mappings.json` (`MAPPING_SEED_PATH`), upserted each time the hub service boots.

`pnpm deps:down` stops the containers and deletes their data.

Defaults match `compose.yaml`, so no `.env` is needed. If ports 5432 or 6379 are taken, start compose with `POSTGRES_PORT`/`REDIS_PORT` and point the hub and tests at them with `DATABASE_URL`/`REDIS_URL` (see `.env.example`).

The hub never migrates itself: always run `pnpm migrate` before starting it. The test suite runs the same migrations in its global setup.

## Repository layout

| Path | What |
|---|---|
| `apps/hub` | The hub: one NestJS + Fastify codebase, deployed as the hub service (`src/main.ts`) and the worker process (`src/worker-main.ts`) (ADR 0001) |
| `compose.yaml` | Local infrastructure; only components from the closed list |
| `.github/workflows/ci.yml` | CI: the same `pnpm test` against Postgres and Redis service containers |

Later: `packages/mock-satusehat`, `packages/simulator`, `apps/dashboard`.

## Decisions

These were fixed before any feature code. The reasoning behind each lives in the ADRs.

### Locked stack

| Concern | Choice |
|---|---|
| Hub service and worker | TypeScript on Node 24, NestJS with the Fastify adapter |
| Data access | Kysely (typed SQL; locking and transactions stay visible, no ORM) |
| Tests | Vitest, against real Postgres and Redis |
| Dashboard | Next.js (three screens) |
| Tracing | OpenTelemetry with Jaeger as the one trace backend |

### Architecture decision records

- [0001 Modular monolith with a separate worker process, not microservices](docs/adr/0001-modular-monolith.md)
- [0002 Postgres transactional outbox as the queue; no message broker](docs/adr/0002-postgres-outbox-no-broker.md)
- [0003 Postgres is the source of truth for idempotency; Redis is only a fast path](docs/adr/0003-postgres-is-idempotency-source-of-truth.md)
- [0004 Claim effect-once, serialised per case: one step in flight per case](docs/adr/0004-effect-once-one-step-in-flight-per-case.md)
- [0005 Search SATUSEHAT by local identifier before every create](docs/adr/0005-search-then-create.md)
- [0006 The mock SATUSEHAT enforces validation rules with its own implementation](docs/adr/0006-mock-validates-independently.md)
- [0007 Cases end only by completion or by an operator abandoning them](docs/adr/0007-cases-end-by-completion-or-operator-abandonment.md)

### Why not microservices

The hub is one codebase with explicit module boundaries (Ingestion, Case Orchestration, Outbox and Worker, SATUSEHAT Adapter, Mapping and Lookup, Validation, Reconciliation, Observability), deployed as a hub service and a worker process. Splitting it would add network hops, distributed transactions and deployment surface without solving any problem this project has. The guarantees it sets out to prove (idempotency, per-case ordering, effect-once) are easiest to prove when their state lives in one Postgres database behind one transaction boundary. See ADR 0001.

### Closed component list

Postgres, Redis, Prometheus, Grafana, OpenTelemetry with Jaeger, the mock SATUSEHAT, the source simulator, the hub service and worker, and a three-screen Next.js dashboard. Nothing else is added. There is no message broker: the queue is a Postgres outbox (ADR 0002). Everything runs from one local compose setup.

### Effect-once, not exactly-once

Source systems deliver at least once; the hub deduplicates on ingest and preserves order per case. No network path can promise exactly-once delivery, so the hub does not claim it. It claims **effect-once**: each step causes exactly one record at SATUSEHAT, which the mock SATUSEHAT verifies from the outside by counting submissions per identifier (ADR 0004, ADR 0005).

### Naive versus real idempotency

`IDEMPOTENCY_STORE=naive-redis` switches ingest to a deliberately broken, clearly labelled store (`apps/hub/src/ingestion/naive-redis-store.ts`) kept next to the real one to show why ADR 0003 exists. It does what looks obvious: GET the idempotency key from Redis, and if it is missing, accept the event and SET the key. Every sequential test passes. Under concurrent duplicates, though, all requests GET "missing" before the first one SETs, so all of them try to accept; one wins and the rest answer `409 EVENT_ALREADY_RECORDED` instead of returning the stored `202`. (Redis may also drop any key at any time, which produces the same wrong answer.)

The real store (`IDEMPOTENCY_STORE=postgres`, the default) inserts the key row first, inside the same short transaction that opens the case. A concurrent duplicate blocks on that row's unique index until the first request commits, then finds it and returns its stored answer. The same race test (`apps/hub/test/ingest-race.test.ts`) runs against both stores, with the naive run marked `test.fails`. To watch it:

```sh
pnpm deps:up
npm run demo:naive-race    # or pnpm demo:naive-race
```

## Not supported

The payload scope is one non-compounded, single-dose scenario and one substitution scenario, mandatory fields only. Everything below is deliberately out of scope:

| Not supported | Why |
|---|---|
| Compounded drugs (both kinds) | Different medication structure and code rules; outside the single-dose scenario the hub is built to prove |
| Tapering regimens | Multi-phase dosage instructions; the supported scope is single-dose only |
| Prescription document references | Outside the mandatory-fields-only scope; they need document handling the simulator and mock do not model |
| Weight and height observations | Separate Observation resources; the hub submits only visit, prescription, dispense and visit update |
| The national prescription number | Outside the mandatory-fields-only scope; the hub uses the source's own prescription identifier |
| The outpatient-pharmacy (pharmacy-side) visit flow | Only the hospital-side flow is in scope; the hub never sends the pharmacy service type |
| Multi-item prescriptions | One step in flight per case assumes one item per prescription; rejected at ingest with `UNSUPPORTED_MULTI_ITEM` (ADR 0004) |
| Therapeutic substitution | Only same-ingredient substitution (a strength change or brand swap) is supported; a different ingredient set dead-letters the case with `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION` |
| Diagnosis on the closing Encounter | Conditions are out of scope; the update visit PUT sends no `Encounter.diagnosis`. Known risk: only SATUSEHAT's Encounter resource page stars it, so the real platform may require it on a `finished` Encounter (#9) |
| Patient creation | Registration is not part of the pharmacy flow; an unknown patient dead-letters the case with `PATIENT_NOT_FOUND` for an operator fix and replay |

## Commitments

Every number an evidence run is judged by is committed in [`bigrun.commitments.json`](bigrun.commitments.json) before any result exists: the Big run (event mix, duplicate timing, fault weights, seed, rate, topology, deadlines, invariants), the Load test thresholds, the Cache run and its bar to stay, and the world dataset size.

- **Every official run is published, pass or fail.**
- Thresholds are never changed after seeing results. If an invariant fails, the implementation gets fixed.
- A change to the commitments file needs a reason in its commit message. Its full history: [commits to `bigrun.commitments.json`](https://github.com/fudi-mahfudin/integration-hub/commits/main/bigrun.commitments.json).
