# Big run 2026-11-28-74df860: PASS

An **official** run: the committed big run, unchanged, from a clean tree.

Run `MX048293`, 2,000 visits and 10,000 events, fault seed 20261125. Started 2026-11-28T07:55:21.938Z, ended 2026-11-28T08:50:39.096Z: completed.

## Provenance

- Git SHA: [`74df8601142232573c46c03938e7db6a63c50f4c`](https://github.com/fudi-mahfudin/integration-hub/commit/74df8601142232573c46c03938e7db6a63c50f4c)
- `bigrun.commitments.json` SHA-256: `913abb09e781f29f26832984e73cb7945a08e5abe84f29807361f2feddc88e44`
- Its last commit: [`7fef1f2`](https://github.com/fudi-mahfudin/integration-hub/commit/7fef1f200a1494e7ffba07e05dda3bdcc5bcf7d9), 2026-11-27T18:33:32+07:00

## Invariants

| Check | Expected | Actual | |
|---|---|---|---|
| every send answered as expected | 10000 | 10000 | PASS |
| every simulator check held | 0 | 0 | PASS |
| the batch drained | completed | completed | PASS |
| steps claimable, in flight or in retry_wait | 0 | 0 | PASS |
| completed cases | 2000 | 2000 | PASS |
| waiting cases | 0 | 0 | PASS |
| dead-lettered cases | 0 | 0 | PASS |
| abandoned cases | 0 | 0 | PASS |
| completed steps | 8000 | 8000 | PASS |
| visits with their four effects in order at the mock | 2000 | 2000 | PASS |
| mock report: duplicate submissions | 0 | 0 | PASS |
| mock report: out-of-order effects | 0 | 0 | PASS |
| mock report: overlapping requests | 0 | 0 | PASS |

## Measurements

Information only: none of these is a pass criterion.

| Measurement | Value |
|---|---|
| Accepted events/s (simulator) | 57.2 |
| Completed steps/s (case API; Prometheus) | 2.41; 2.41 |
| Ingest latency p50 / p95 / p99, client (10000 requests) | 7 / 12 / 15 ms |
| Ingest latency p50 / p95 / p99, server (Prometheus, bucketed) | 3 / 9 / 10 ms |
| End-to-end per case p50 / p95 / p99 / max | 2774.4 / 3195.8 / 3234.0 / 3279.9 s |
| Outbox lag max / p95 | 747.2 / 722.6 s |
| Rate limiter wait p95 | 18 ms |
| Circuit breaker opens | fhir 21 |
| Durations: send / drain / total | 168 / 3149 / 3317 s |

### Realized faults (mock log)

| Group | Calls | Faulted | Rate | By kind |
|---|---|---|---|---|
| reads | 19488 | 5801 | 29.8% | connection_reset 1170, http_503 1089, timeout 1178, http_429 1188, http_500 1176 |
| writes | 9572 | 2878 | 30.1% | http_503 394, http_500_after_apply 635, http_500 399, http_429 390, timeout 196, timeout_after_apply 671, connection_reset 193 |

### Attempts per step (case API)

| Step | Mean | p99 | Max | Histogram (attempts: cases) |
|---|---|---|---|---|
| create_visit | 1.45 | 4 | 6 | 1: 1327, 2: 505, 3: 127, 4: 32, 5: 8, 6: 1 |
| submit_prescription | 1.38 | 3 | 5 | 1: 1358, 2: 535, 3: 90, 4: 14, 5: 3 |
| submit_dispense | 1.41 | 4 | 5 | 1: 1330, 2: 544, 3: 105, 4: 19, 5: 2 |
| update_visit | 1.39 | 4 | 5 | 1: 1384, 2: 484, 3: 105, 4: 19, 5: 8 |

### Platform API calls by status class (mock log)

| Platform API | 2xx | 4xx | 5xx | Cut |
|---|---|---|---|---|
| token | 4 | 0 | 0 | 0 |
| fhir | 20381 | 1578 | 3693 | 3408 |

### Reconciliation after the drain

Run `6af0ad4e-652e-488a-816e-e64a0eba16cb` completed_with_errors: 2000 cases, 412 clean, 0 divergent, 0 skipped, 1588 unchecked.

## Environment

- Apple M1 Pro, 10 cores, 32 GiB RAM, Darwin 27.2.0 (arm64), Docker 29.7.2, Node v24.22.3
- Docker has 10 CPUs and 7.7 GiB; compose 5.5.0; 2 worker processes
- Container limits: hub 1 CPU / 512 MiB, jaeger 1 CPU / 1024 MiB, mock 1 CPU / 512 MiB, postgres 2 CPU / 1024 MiB, prometheus 0.5 CPU / 512 MiB, redis 0.5 CPU / 256 MiB, worker-1 1 CPU / 512 MiB, worker-2 1 CPU / 512 MiB

## Files

- `manifest.json`: every planned visit and send, written before the first send
- `mock-report.json`: `GET /__mock/report` after the drain
- [`mock-log.ndjson.gz`](https://github.com/fudi-mahfudin/integration-hub/releases/download/bigrun-2026-11-28-74df860/mock-log.ndjson.gz): the mock's whole submission log, a release asset (`pnpm bigrun:publish` uploads it)
