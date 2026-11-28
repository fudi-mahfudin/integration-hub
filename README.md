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
| Patient creation | Registering a patient at SATUSEHAT is not a pharmacy act. A patient not found by NIK or the documented fallbacks dead-letters the case with `PATIENT_NOT_FOUND`, and one the lookup can't tell apart from another with `PATIENT_AMBIGUOUS`. |

Abandoning a case leaves the records its completed steps created at SATUSEHAT in place; cleaning them up is a hospital operations task (ADR 0007).

## Known risks

| Risk | Why it is taken |
|---|---|
| `Encounter.diagnosis` is not sent when the update visit step closes a visit | Only the Encounter resource page stars it; the rule dictionary and the guide don't require it, and the source event contract carries no diagnosis (a Condition is out of scope). If SATUSEHAT turns out to require it on a `finished` Encounter, every update visit will be rejected, and the contract needs a diagnosis field. |

## Commitments

Every number an evidence run is judged by is committed in [`bigrun.commitments.json`](bigrun.commitments.json) before any result exists:

- **Big run**: 10,000 events (2,000 visits × 4 events + 2,000 duplicates) with 30% transient faults on reads and writes, judged by zero lost events, zero duplicate submissions, order per case, and zero dead-lettered or abandoned cases.
- **Load test**: ingest capacity at 200 events/s for 5 min after a 30s warm-up, with no faults, judged by p95, p99 and the non-2xx rate.
- **Cache run**: the before-and-after that decides whether each IHS-number cache stays in the code (`pnpm cacherun`, below).
- **World dataset**: 1,000 patients drawn uniformly across visits, and 30 practitioners.

The rules:

- **Every official run is published, pass or fail.**
- A change to the commitments file needs a reason in its commit message. Its full history is public: [history of `bigrun.commitments.json`](https://github.com/fudi-mahfudin/integration-hub/commits/main/bigrun.commitments.json).
- The big-run harness refuses an official run on a dirty tree or if the file changed since its own commit, and its report records the git SHA, the file's hash and that commit's date. The load test follows the same rules.

## Big run results

<!-- bigrun:start -->
Latest official run: **PASS**, [`2026-11-28-74df860`](results/bigrun/2026-11-28-74df860/report.md), started 2026-11-28 07:55 UTC at `74df860`.

| | |
|---|---|
| Events sent | 10,000 |
| Cases completed | 2,000 |
| Total duration | 55.3 min |
| Accepted events/s | 57.2 |
| Ingest p95 (client) | 12 ms |
| End-to-end per case p95 | 3195.8 s |
| Realized fault rate, reads / writes | 29.8% / 30.1% |

Environment: Apple M1 Pro, 10 cores, 32 GiB RAM, Darwin 27.2.0 (arm64), Docker 29.7.2, Node v24.22.3.

Every official run: [results/bigrun/INDEX.md](results/bigrun/INDEX.md). The commitments and their history: [history of `bigrun.commitments.json`](https://github.com/fudi-mahfudin/integration-hub/commits/main/bigrun.commitments.json).
<!-- bigrun:end -->

### Running the big run

`pnpm bigrun` brings the compose stack up as committed (1 hub service and 2 workers with pinned limits, scheduled reconciliation off, 5% trace sampling), refuses to run if the stack differs or delivers anywhere but the mock, and drives the committed run. In order, it writes the manifest, sets the faults with one `PUT /__mock/faults`, sends the batch open loop at 50 events/s, and polls the case list every 5s. Then it judges every invariant from the hub's side and the mock's and writes a report. It exits 0 on PASS, 1 on FAIL and 2 if it refuses to start. Waiting gives up after 10 min without a completed step, or 60 min after the first send; either way it still writes a full FAIL report listing the stuck cases.

- `pnpm bigrun --official`: the committed run, from a clean tree only. It writes `results/bigrun/<date>-<shortsha>/` (`report.md`, `report.json`, `manifest.json`, `mock-report.json`, and `mock-log.ndjson.gz`, which is not committed) and lists the run in [`results/bigrun/INDEX.md`](results/bigrun/INDEX.md). Commit them, pass or fail.
- `pnpm bigrun:publish`: uploads the latest official run's mock log as a GitHub Release asset (`bigrun-<dir>`) and rewrites the section above.
- `pnpm bigrun --ci`: the same run at 200 visits, with the same ratios, fault weights and deadlines. CI runs it on every pull request.
- `pnpm bigrun --set path=value`: overrides a committed value under `bigRun` (e.g. `--set arrival.eventsPerSecond=25`). The report flags every override, and such a run is never official.

Runs that are not official write to `results/bigrun-unofficial/` (not committed). The harness reaches the stack on `localhost` (`BIGRUN_HUB_URL`, `BIGRUN_MOCK_URL`, `BIGRUN_PROMETHEUS_URL`).

## Load test results

<!-- loadtest:start -->
No official load test yet. `pnpm loadtest --official` runs one and writes its results here.
<!-- loadtest:end -->

### Running the load test

`pnpm loadtest` measures how fast the hub accepts source events, separately from the big run. It brings the stack up exactly as the big run does, and refuses to run if the stack differs or the mock has faults set. The source simulator then plans an event file from the world dataset: the big run's seed and event mix, a fifth of the requests duplicates (same `Idempotency-Key`, byte-identical body), one request per arrival. k6 (`grafana/k6:2.4.0`, the compose service `k6`, profile `loadtest`) replays the file in order with `constant-arrival-rate`: 200 events/s for a 30s warm-up, then 200 events/s for the 5 min measured phase. The committed thresholds apply only to the measured phase: ingest p95 < 200 ms, p99 < 500 ms and non-2xx < 0.1%, measured on the client side. The run also fails if the measured phase sent fewer requests than its 60,000 arrivals (dropped, or failed before sending), because then it didn't hold the committed rate. It also fails if k6 itself ended abnormally. The harness exits 0 on PASS, 1 on FAIL and 2 if it refuses to start.

- `pnpm loadtest --official`: the committed load test, from a clean tree only. It writes `results/k6/<date>-<shortsha>/` (`report.md`, `report.json`, `k6-config.json`, `k6-summary.json`, and `events.ndjson`, which is not committed), lists the run in [`results/k6/INDEX.md`](results/k6/INDEX.md), and rewrites the section above. Commit them, pass or fail.
- `pnpm loadtest --set path=value`: overrides a committed value under `loadTest` (e.g. `--set durationSeconds=20`). The report flags every override, and such a run is never official. It writes to `results/k6-unofficial/` (not committed).

The workers keep delivering the load test's cases after k6 ends. Run `pnpm stack:down` before a big run so the two don't share the stack.

## Cache run results

<!-- cacherun:start -->
Latest official Cache run: [2026-11-28-d0550b0](results/cache/2026-11-28-d0550b0/report.md), 2026-11-28 02:03 UTC, at `d0550b0`.

- `ihs_practitioner`: upstream reads per case 37.3% fewer, e2e p95 19.7% better (spread 14.4 s): clears bars 1 and 2: stays if the official big run passes with it on (bar 3).
- `ihs_patient`: upstream reads per case 9.6% fewer, e2e p95 4.2% better (spread 12.7 s): misses the bar: removed from the code, this result kept.

Every official Cache run: [results/cache/INDEX.md](results/cache/INDEX.md).
<!-- cacherun:end -->

### Running the Cache run

`pnpm cacherun` decides from measured numbers whether each IHS-number cache stays in the code (#20). It runs the three committed arms, no cache, `ihs_practitioner` only, and both caches, three times each, alternating: 9 runs. Each run deletes the Postgres and Redis containers with their data, so it starts with no cases and a cold cache. It then brings the stack up as the big run does, with the arm's `IHS_CACHES` on the workers, and sets the mock to answer every read 150 ms and every write 300 ms late, with no faults. These latencies are assumed constants, not sandbox measurements. Then it drives the big run's batch to completion. It measures upstream reads (the GETs the mock received) per completed case, each cache's hit ratio (from the workers' `cache_requests_total`), end-to-end case time p50/p95, attempt duration and drain duration. A cache stays only if, against the arm without it, the median reads per completed case drop by ≥ 20%, the median of the runs' e2e p95 improves by ≥ 10% and by more than the max–min spread of either arm's runs, and an official big run passes with it on. A cache that misses is removed from the code, and its result stays published. `ihs_patient` was removed that way: the hub now refuses `IHS_CACHES=ihs_patient`, and `pnpm cacherun` refuses (exit 2) before its first run, since its third arm needs it. The committed Cache run reruns only at `d0550b0`, where it was measured. With the committed latencies a run takes about 40 minutes, so the whole Cache run takes about 6 hours. It exits 0 once it has written its report, whatever the caches' outcomes, 1 if a run could not be measured (the runs measured so far stay in `runs.json`), and 2 if it refuses to start.

- `pnpm cacherun --official`: the committed Cache run, from a clean tree only. It writes `results/cache/<date>-<shortsha>/` (`report.md`, `report.json`, `runs.json`), lists the run in `results/cache/INDEX.md`, and rewrites the section above. Commit them, pass or fail.
- `pnpm cacherun --ci`: each run at the CI visits (200). `pnpm cacherun --set path=value` overrides a committed value under `cacheRun` (e.g. `--set runsPerArm=1`). Neither is ever official; they write to `results/cache-unofficial/` (not committed).

It deletes the local Postgres and Redis data, like `pnpm stack:down`.

## Contract check

The Contract check (`pnpm contract:check`, #48) sends the same fixed requests to the real SATUSEHAT sandbox and to an in-process mock SATUSEHAT, and diffs their answers by shape, never by value. It is how a change in the real platform is noticed. Run it by hand before closing each milestone and after a SATUSEHAT portal version bump. It refuses to run when `CI` is set.

1. **Set up once.** Have the sandbox credential `/wizard` walk you through the portal (Sandbox > Kode Akses API). It writes the git-ignored `.env.live` (see `.env.live.example`), creates our sandbox Location with one POST, and records its id, the official dummy NIKs and a KFA 93 product in the git-ignored `live-seed.json` (see `live-seed.example.json`). Credentials come from the environment only.
2. **Run** `pnpm contract:check`. In order, it sends: a token request; a KFA v2 product lookup; Patient, prescriber and pharmacist searches by NIK; a Location search; an Encounter create, its search and its PUT; a MedicationRequest create and its search; a MedicationDispense create (identifiers unique to the run, `CONTRACT-<runId>`); a deliberately invalid payload (400); a bogus token (401); and a random id (404). A request that needs an answer one side didn't give is skipped. It never provokes 429, 5xx or the token throttle.
3. **Read the report.** A request **fails** when the status, the media type, `Retry-After`, a value type, `resourceType`, an OperationOutcome issue severity/code, or a key the hub reads differs. It **warns** on a key or a `Location`/`ETag` header only the sandbox sends that the hub doesn't read. Ordering and keys only the mock has are **info**. Exit code: 0 pass, 1 fail, 3 inconclusive (a side gave no answer), 2 refused.
4. **Commit the tag change.** Each template whose every request passed is re-tagged `sandbox-observed` with the check date in `packages/mock-satusehat/src/templates/sandbox-observed.ts`; a template that failed loses its tag. Commit that file. Raw answers go to the git-ignored `.recordings/contract/<runId>/` and are never committed or shared; only `report.md`, which holds no values, may be shared.

## Quick start

You need Node 24 (see `.nvmrc`), pnpm 11, and Docker.

```sh
corepack enable     # use the pnpm version pinned in package.json
pnpm stack:up       # build and start everything in compose, then run a small simulated batch to completion
```

`pnpm stack:up` builds the images. It starts Postgres, Redis, Prometheus, Grafana and Jaeger, runs the one-shot `migrate`, and starts the mock SATUSEHAT, the hub service and two workers, waiting until each is healthy. Then it runs the source simulator once. The simulator plans 20 fictional visits from the world dataset (seed 44). It sends their 80 source events, plus duplicates, events out of order, substitutions and fallback patient lookups, to the hub as the development source system. It waits until every case has completed and exits 0, or exits 1 and prints every failed check. Run it again for another batch: each run's visits get new ids. `SIM_SEED` and `SIM_VISITS` change the batch (`SIM_VISITS=200 pnpm stack:up`; the other settings are in [packages/simulator/README.md](packages/simulator/README.md)).

While it runs and afterwards, look at:

- the cases: `curl -H 'Authorization: Bearer dev-source-key' 'http://localhost:3000/v1/cases?source=simulator'`
- what reached SATUSEHAT: `curl http://localhost:3001/__mock/report` (empty sections: no duplicate submission, nothing out of order) and `http://localhost:3001/__mock/log`
- Grafana on http://localhost:3300, Jaeger on http://localhost:16686, Prometheus on http://localhost:9090

`pnpm stack:down` stops everything and deletes its data.

## Run it from a clean clone

To develop, run the parts on the host instead:

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
pnpm --filter @integration-hub/hub start # serves http://localhost:3000
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
node packages/mock-satusehat/dist/main.js         # mock SATUSEHAT on http://localhost:3001
pnpm --filter @integration-hub/hub start:worker   # claims steps from the Postgres outbox
```

Each worker serves its metrics on `http://localhost:3002/metrics` (`WORKER_PORT`; a second worker on the same host needs another, e.g. `WORKER_PORT=3003`), and the hub service on `http://localhost:3000/metrics`. Both also serve `/livez` and `/readyz` (see [docs/api.md](docs/api.md#get-livez-and-get-readyz)). To see the metrics in Grafana:

```sh
pnpm obs:up   # start Prometheus (http://localhost:9090) and Grafana (http://localhost:3300), wait until healthy
```

Both start scripts preload `dist/instrumentation.js` (`node --import`), which instruments pg, ioredis and the HTTP server and client for traces (ADR 0008).

Prometheus scrapes the hub service on port 3000 and workers on 3002 and 3003 every 5s, through `host.docker.internal`. Grafana opens on the **Hub overview** dashboard (is ingest healthy, and where are the cases?); **Worker & outbox** (is work flowing?) and **Upstreams & cache** (is SATUSEHAT the problem?) are beside it in the *Integration Hub* folder. The dashboards are provisioned read-only from `observability/grafana/dashboards/*.json`: change the JSON, not the UI. There are no alert rules.

`pnpm obs:up` also starts Jaeger (http://localhost:16686), where the hub service and the workers export traces over OTLP (`TRACE_EXPORT_URL`, default `http://localhost:4318/v1/traces`). A visit spans up to four traces, one per source event: each starts at its `POST /v1/events` and its `ingest.accept`, and the attempts of that event's step follow as children, with their SATUSEHAT, KFA, IHS-number and token calls, pg queries and Redis commands under them. Search by the tag `case.id=<case id>` to see all of a case's traces. Every span is redacted before export, like a log line. Sampling is parent-based, at `TRACE_SAMPLE_RATIO` of the traces that start in the hub (default 1; the big run uses 0.05). Jaeger keeps traces in memory, so a restart loses them. Without Jaeger running, the spans are dropped.

The worker loads the mapping seeds at boot: `apps/hub/seed/location-mappings.json` (the simulator's location codes mapped to the world dataset's locations) and `apps/hub/seed/drug-mappings.json` (its local drug codes mapped to the world's KFA codes, plus two entries noted as deliberately wrong for the KFA failure paths). Loading them again changes nothing. KFA details are fetched from KFA v2 the first time a code is used and stored.

Operators act with the admin API key (`HUB_ADMIN_API_KEY`; the development key `dev-admin-key` is public, and production must set its own): they keep mappings through `PUT`/`DELETE /v1/admin/mappings/...`, which writes the same tables as the seeds, and replay or abandon cases (see [docs/api.md](docs/api.md)). The seeds are loaded at every worker boot, so a seeded code an operator changed through the API is set back to its seed entry when a worker restarts: change the seed file too. A waiting case is flagged `stalled` after `STALLED_AFTER_MS` (default 24h); that changes nothing about it. Reconciliation compares the cases at rest with their records at SATUSEHAT and reports every divergence without changing a case. The workers run it every `RECONCILIATION_INTERVAL_MS` (default 15 min; `0` turns that off), and an operator can request a run through `POST /v1/admin/reconciliation/runs`.

The worker keeps under a rate limit per platform API (100 rps for FHIR and 50 for KFA v2 against the mock; 5 and 2 with `SATUSEHAT_PROFILE=live-sandbox`), shared by all worker processes through Redis. Without Redis, each worker keeps to its share of it, by `WORKER_PROCESSES` (default 2). While a platform API's circuit breaker is open, the worker claims nothing.

The worker caches the practitioners' IHS numbers it finds by an exact NIK lookup in Redis for 24h (`ihs_practitioner`; `IHS_CACHES=none` turns it off), under an HMAC of the NIK with `IHS_CACHE_PEPPER` (the development pepper is public; production must set its own). Patients are searched for at SATUSEHAT every time: their cache missed the Cache run bar and was removed. Fallback lookups and "not found" are never cached. A Redis error, or an answer slower than 50 ms, counts as a miss. A replayed step searches past the cache and overwrites the entry, and SATUSEHAT permanently rejecting a step's write deletes every entry that attempt used. Each attempt log entry says whether each IHS number came from the cache or from SATUSEHAT (`lookupSources`). Redis keeps nothing on disk.

To see why Redis alone can't detect duplicate ingests (ADR 0003), run `npm run demo:naive-race` (after `pnpm deps:up` and `pnpm migrate`). It fires 20 identical requests at once against the deliberately broken `IDEMPOTENCY_STORE=naive-redis` and then against the Postgres store, and prints how the answers differ.

To run the mock SATUSEHAT on its own (it needs no Postgres or Redis), see [packages/mock-satusehat/README.md](packages/mock-satusehat/README.md).

`pnpm deps:down` stops the containers and deletes their data.

Defaults match `compose.yaml`, so no `.env` is needed. If ports 5432 or 6379 are taken, start compose with `POSTGRES_PORT`/`REDIS_PORT` (and `PROMETHEUS_PORT`/`GRAFANA_PORT`/`JAEGER_UI_PORT`/`JAEGER_OTLP_PORT` for 9090, 3300, 16686 and 4318) and point the hub and tests at them with `DATABASE_URL`/`REDIS_URL` (see `.env.example`).

The hub never migrates itself: always run `pnpm migrate` before starting it. At start-up the hub service and each worker wait up to 30s for Postgres, then exit 1 if the schema is at another migration than the one they were built for. The test suite runs the same migrations in its global setup.

**Stopping.** `SIGTERM` or `SIGINT` (Ctrl-C) drains a process instead of killing it, and `/readyz` turns `503 draining`. The hub service answers requests on connections still open with `503 SERVICE_DRAINING` and gives requests in flight 10s; `SHUTDOWN_DELAY_MS` (default 0) keeps it serving that long first, for a load balancer. A worker claims nothing more and lets its attempt in progress end, for up to `WORKER_DRAIN_DEADLINE_MS` (default 70s). At that deadline, or at a second signal, it aborts the attempt and logs it as `worker_shutdown`, and another worker takes the step at once. A reconciliation run it was executing is stopped once it holds no step lease, marked `interrupted`, and not resumed. Both exit 0.

**In containers.** `pnpm app:up` builds the hub image (`apps/hub/Dockerfile`) and the mock's (`packages/mock-satusehat/Dockerfile`). It starts the mock SATUSEHAT on port 3001 (`MOCK_PORT`), the hub service on port 3000 and two workers on 3002 and 3003 in compose, after the one-shot `migrate` service has completed. The workers deliver to that mock, so stop a mock running on the host first. `pnpm stack:up` does the same and also runs the source simulator (see [Quick start](#quick-start)). Compose gives the hub service 15s and the workers 80s to drain before it kills them (`stop_grace_period`).

## Repository layout

| Path | What |
|---|---|
| `apps/hub` | The hub: one NestJS + Fastify codebase, deployed as the hub service (`main.ts`) and the worker process (`worker-main.ts`) (ADR 0001) |
| `apps/hub/seed` | The operator's location and drug mapping seeds, loaded idempotently at boot |
| `packages/mock-satusehat` | The mock SATUSEHAT: a stateful fake platform with its own validator (ADR 0006) and the `/__mock/*` inspection and control API; never deployed publicly |
| `packages/simulator` | The source simulator: plans seeded batches of fictional visits from the world dataset and sends them to the hub as a source system |
| `packages/bigrun` | The big-run harness (`pnpm bigrun`): drives the committed big run through the simulator, judges it from the hub's and the mock's side, and writes and publishes its report |
| `packages/bigrun/k6` | The load test's k6 script; `pnpm loadtest` (same package) builds its options from the commitments and judges its summary |
| `packages/bigrun/src/cacherun` | The Cache run (`pnpm cacherun`, same package): runs the arms, measures them, and judges each IHS-number cache against the bar |
| `packages/contract-check` | The Contract check (`pnpm contract:check`): the fixed requests, the shape diff, and the re-tagging of passed templates; local-only |
| `results/bigrun` | Every official big run's report, and `INDEX.md` |
| `results/k6` | Every official load test's report, and `INDEX.md` |
| `results/cache` | Every official Cache run's report, and `INDEX.md` |
| `docs/api.md` | The hub's API contract |
| `compose.yaml` | Local infrastructure, and (profile `app`) the mock SATUSEHAT, the hub service, two workers and the one-shot `migrate`, (profile `simulator`) the one-shot source simulator, and (profile `loadtest`) k6, the load test's one-shot load generator; only components from the closed list |
| `observability` | Prometheus scrape config and the Grafana data source and dashboards, provisioned from committed JSON (Jaeger needs no config) |
| `.github/workflows/ci.yml` | CI: typecheck, the import-boundary check (`pnpm boundaries`), and the same `pnpm test` against Postgres and Redis service containers; and the big run at 200 visits (`pnpm bigrun --ci`) against the compose stack |

Later: `apps/dashboard`.
