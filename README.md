# Integration Hub

A hub that takes pharmacy events from a hospital's source system and delivers them to SATUSEHAT (HL7 FHIR R4), so that each step of a visit has its effect at SATUSEHAT once (effect-once) and in order. Domain terms are in [GLOSSARY.md](GLOSSARY.md); decisions are in [docs/adr](docs/adr).

## Decisions

**Locked stack.** NestJS + Fastify for the hub, Kysely for data access (no ORM, so transactions and locks stay visible), Vitest for tests, Next.js for the three-screen dashboard, Jaeger as the trace backend.

**Architecture decision records** ([docs/adr](docs/adr)):

- [0001](docs/adr/0001-modular-monolith.md) Modular monolith with a separate worker process, not microservices
- [0002](docs/adr/0002-postgres-outbox-no-broker.md) Postgres transactional outbox as the queue; no message broker
- [0003](docs/adr/0003-postgres-is-idempotency-source-of-truth.md) Postgres is the source of truth for idempotency; Redis is only a fast path
- [0004](docs/adr/0004-effect-once-one-step-in-flight-per-case.md) Claim effect-once, serialised per case: one step in flight per case
- [0005](docs/adr/0005-search-then-create.md) Search SATUSEHAT by local identifier before every create
- [0006](docs/adr/0006-mock-validates-independently.md) The mock SATUSEHAT enforces validation rules with its own implementation
- [0007](docs/adr/0007-cases-end-by-completion-or-operator-abandonment.md) Cases end only by completion or by an operator abandoning them

**Why not microservices.** The guarantees this project exists to show (idempotent ingest, order per case, effect-once) are easiest to prove when the state they depend on sits in one Postgres database behind one transaction boundary. Splitting the hub would add network hops, distributed transactions and deployment surface without solving a problem the project has, and a message broker would bring back the dual write the outbox removes. The hub is one codebase with explicit module boundaries, deployed as a hub service and a worker process. The mock SATUSEHAT and the source simulator are separate programs only because they stand in for external systems. See ADR 0001 and 0002.

**Closed component list.** Postgres, Redis, Prometheus, Grafana, OpenTelemetry + Jaeger, the mock SATUSEHAT, the source simulator, the hub service + worker, and the Next.js dashboard. Nothing else is added: no Kafka or RabbitMQ, Kubernetes, service mesh, event sourcing, CQRS, ELK/Loki, multi-role auth or user model.

**Effect-once, not exactly-once.** The hub claims that each step causes exactly one record at SATUSEHAT however many times it is delivered or attempted, and that steps of a case take effect in order. It does not claim exactly-once delivery, which no network path can promise. The claim is to be checked by the mock SATUSEHAT, which counts submissions independently of the hub (ADR 0004, 0006).

## Not supported

This is the design the hub is built to; the ingest and dead-letter codes below land with the tickets that implement each step.

| What | Why |
|---|---|
| Compounded drugs | A compounded item has several ingredients, each with its own KFA code and quantity. A case carries exactly one drug item with one KFA product. |
| Tapering regimens | A tapering dose needs a sequence of dosage instructions. The hub sends one dosage instruction per prescription item. |
| Prescription document references | The source event contract carries no document, and nothing in the four-step flow needs one. |
| Weight/height observations | They are separate Observation records outside the four pharmacy steps (create visit, submit prescription, submit dispense, update visit). |
| The national prescription number | Prescriptions are identified only by the hospital's own identifiers under the `prescription/{org}` and `prescription-item/{org}` systems. |
| The outpatient-pharmacy visit flow | Only the hospital-side flow is modelled, so `Encounter.serviceType` 64 (Pharmacy) is never sent. |
| Multi-item prescriptions | One step in flight per case is what keeps visit records from being duplicated. One case per item would share the visit steps across cases and break that, so a prescription without exactly one item is rejected at ingest with `UNSUPPORTED_MULTI_ITEM` (ADR 0004). |
| Therapeutic substitution | Only substitution within the same KFA 91 set (a different product with the same active ingredients) is supported. A dispense with different active ingredients dead-letters the case with `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`. |
| Patient creation | Registering a patient at SATUSEHAT is not a pharmacy act. A patient not found by NIK or the documented fallbacks dead-letters the case with `PATIENT_NOT_FOUND`. |

Abandoning a case leaves the records its completed steps created at SATUSEHAT in place; cleaning them up is a hospital operations task (ADR 0007).

## Commitments

Every number an evidence run is judged by is committed in [`bigrun.commitments.json`](bigrun.commitments.json) before any result exists:

- **Big run**: 10,000 events (2,000 visits × 4 events + 2,000 duplicates) with 30% transient faults on reads and writes, judged by zero lost events, zero duplicate submissions, order per case, and zero dead-lettered or abandoned cases.
- **Load test**: ingest capacity at 200 events/s for 5 min after a 30s warm-up, with no faults, judged by p95, p99 and the non-2xx rate.
- **Cache run**: the before-and-after that decides whether a cache stays in the code.
- **World dataset**: 1,000 patients drawn uniformly across visits, and 30 practitioners.

The rules:

- **Every official run is published, pass or fail.**
- A change to the commitments file needs a reason in its commit message. Its full history is public: [history of `bigrun.commitments.json`](https://github.com/fudi-mahfudin/integration-hub/commits/main/bigrun.commitments.json).
- The big-run harness will refuse an official run on a dirty tree or if the file changed since its own commit, and its report will record the git SHA, the file's hash and that commit's date.

## Run it from a clean clone

You need Node 24 (see `.nvmrc`), pnpm 11, and Docker.

```sh
corepack enable     # use the pnpm version pinned in package.json
pnpm install        # install workspace dependencies
pnpm deps:up        # start Postgres and Redis (compose), wait until healthy
pnpm migrate        # one-shot: apply database migrations
pnpm test           # run the full suite against the real Postgres and Redis
```

To run the hub service itself:

```sh
pnpm build
node apps/hub/dist/main.js     # serves http://localhost:3000
```

Then send a source event as the development source system (its API key, `dev-source-key`, is public and for local runs only; production sets `HUB_SOURCES`):

```sh
curl -i http://localhost:3000/v1/events \
  -H 'Authorization: Bearer dev-source-key' \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"type":"visit.started","visitId":"V-1","occurredAt":"2026-03-02T08:00:00+07:00","data":{"patient":{"nik":"9271060312000001","mrn":"MRN-1"},"practitioner":{"nik":"7209061211900001"},"encounterClass":"AMB","locationCode":"POLI-UMUM","startedAt":"2026-03-02T08:00:00+07:00"}}'
```

The API is described in [docs/api.md](docs/api.md).

To deliver accepted visits to SATUSEHAT, also run the mock SATUSEHAT and the worker process (each in its own terminal, after `pnpm build`). The worker's defaults point at the mock on port 3001 with its public development credentials:

```sh
node packages/mock-satusehat/dist/main.js   # mock SATUSEHAT on http://localhost:3001
node apps/hub/dist/worker-main.js           # claims steps from the Postgres outbox
```

The worker loads the location mapping seed (`apps/hub/seed/location-mappings.json`, the simulator's location codes mapped to the world dataset's locations) at boot. Loading it again changes nothing.

To see why Redis alone can't detect duplicate ingests (ADR 0003), run `npm run demo:naive-race` (after `pnpm deps:up` and `pnpm migrate`). It fires 20 identical requests at once against the deliberately broken `IDEMPOTENCY_STORE=naive-redis` and then against the Postgres store, and prints how the answers differ.

To run the mock SATUSEHAT on its own (it needs no Postgres or Redis), see [packages/mock-satusehat/README.md](packages/mock-satusehat/README.md).

`pnpm deps:down` stops the containers and deletes their data.

Defaults match `compose.yaml`, so no `.env` is needed. If ports 5432 or 6379 are taken, start compose with `POSTGRES_PORT`/`REDIS_PORT` and point the hub and tests at them with `DATABASE_URL`/`REDIS_URL` (see `.env.example`).

The hub never migrates itself: always run `pnpm migrate` before starting it. The test suite runs the same migrations in its global setup.

## Repository layout

| Path | What |
|---|---|
| `apps/hub` | The hub: one NestJS + Fastify codebase, deployed as the hub service (`main.ts`) and the worker process (`worker-main.ts`) (ADR 0001) |
| `apps/hub/seed` | The operator's location mapping seed, loaded idempotently at boot |
| `packages/mock-satusehat` | The mock SATUSEHAT: a stateful fake platform with its own validator (ADR 0006) and the `/__mock/*` inspection and control API; never deployed publicly |
| `docs/api.md` | The hub's API contract |
| `compose.yaml` | Local infrastructure; only components from the closed list |
| `.github/workflows/ci.yml` | CI: typecheck, the import-boundary check (`pnpm boundaries`), and the same `pnpm test` against Postgres and Redis service containers |

Later: `packages/simulator`, `apps/dashboard`.
