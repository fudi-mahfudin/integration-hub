# Cache run 2026-11-28-d0550b0

**Official run**, 2026-11-28T02:03:29.059Z → 2026-11-28T07:39:25.947Z.


Each run: the big run's event mix at 50 events/s, 2,000 visits, no faults, the big run's topology, from an empty Postgres and Redis. The mock answers every read 150 ms and every write 300 ms late: **assumed constants, not sandbox measurements**. Arms "no cache", "ihs_practitioner only", "ihs_patient + ihs_practitioner", 3× each, alternating.

## Decisions

| Cache | Against | Reads per case (median, without → with) | Bar 1: ≥ 20.0% fewer | e2e p95 (median, without → with) | Spread (larger arm) | Bar 2: ≥ 10.0% and > spread | Outcome |
|---|---|---|---|---|---|---|---|
| `ihs_practitioner` | no cache | 8.01 → 5.02 | 37.3% PASS | 2372.8 → 1905.0 s | 14.4 s | 19.7% PASS | clears bars 1 and 2: stays if the official big run passes with it on (bar 3) |
| `ihs_patient` | ihs_practitioner only | 5.02 → 4.54 | 9.6% FAIL | 1905.0 → 1825.1 s | 12.7 s | 4.2% FAIL | misses the bar: removed from the code, this result kept |

Bar 2 compares the median of each arm's per-run e2e p95. The commitment doesn't say which arm's max–min spread the improvement must exceed, so it must exceed both. Bar 3 (the official big run passes with the cache on) is judged by that run: see [results/bigrun/INDEX.md](../../bigrun/INDEX.md).

## Arms

| Arm | Runs | Upstream reads per completed case | e2e p50 | e2e p95 per run | Attempt p95 | Drain |
|---|---|---|---|---|---|---|
| no cache | 3 | 8.01 | 2226.2 s | 2362.1 / 2376.5 / 2372.8 s | 790 ms | 2383 s |
| ihs_practitioner only | 3 | 5.02 | 1759.1 s | 1898.5 / 1911.2 / 1905.0 s | 633 ms | 1915 s |
| ihs_patient + ihs_practitioner | 3 | 4.54 | 1679.7 s | 1822.4 / 1831.1 / 1825.1 s | 627 ms | 1838 s |

Medians over the arm's runs.

## Runs

| # | Arm | Big-run verdict | Completed cases | Reads per case | Hit ratio patient / practitioner | e2e p50 / p95 | Attempt p50 / p95 | Drain / total |
|---|---|---|---|---|---|---|---|---|
| 1 | no cache | PASS | 2000 | 8.01 | n/a / n/a | 2218.2 / 2362.1 s | 629 / 789 ms | 2370 / 2538 s |
| 2 | ihs_practitioner only | PASS | 2000 | 5.02 | n/a / 99.5% | 1754.1 / 1898.5 s | 477 / 632 ms | 1909 / 2076 s |
| 3 | ihs_patient + ihs_practitioner | PASS | 2000 | 4.54 | 53.7% / 99.5% | 1677.6 / 1822.4 s | 475 / 627 ms | 1833 / 2001 s |
| 4 | no cache | PASS | 2000 | 8.01 | n/a / n/a | 2229.8 / 2376.5 s | 634 / 790 ms | 2387 / 2555 s |
| 5 | ihs_practitioner only | PASS | 2000 | 5.02 | n/a / 99.5% | 1765.2 / 1911.2 s | 480 / 637 ms | 1921 / 2089 s |
| 6 | ihs_patient + ihs_practitioner | PASS | 2000 | 4.54 | 53.7% / 99.5% | 1685.2 / 1831.1 s | 477 / 627 ms | 1840 / 2007 s |
| 7 | no cache | PASS | 2000 | 8.01 | n/a / n/a | 2226.2 / 2372.8 s | 631 / 791 ms | 2383 / 2550 s |
| 8 | ihs_practitioner only | PASS | 2000 | 5.02 | n/a / 99.5% | 1759.1 / 1905.0 s | 480 / 633 ms | 1915 / 2083 s |
| 9 | ihs_patient + ihs_practitioner | PASS | 2000 | 4.54 | 53.7% / 99.5% | 1679.7 / 1825.1 s | 476 / 627 ms | 1838 / 2006 s |

Reads are the GET requests the mock received (FHIR searches, KFA lookups). The hit ratio is hits over the requests that read the cache. The big-run verdict is information: faults are off, and the bar doesn't read it.

## Environment

- Apple M1 Pro, 10 cores, 32 GiB RAM, Darwin 27.2.0 (arm64)
- Node v24.22.3, Docker 29.7.2 (10 CPUs, 7.7 GiB), Compose 5.5.0
- 2 worker processes; limits: hub 1 CPU / 512m, jaeger 1 CPU / 1024m, mock 1 CPU / 512m, postgres 2 CPU / 1024m, prometheus 0.5 CPU / 512m, redis 0.5 CPU / 256m, worker-1 1 CPU / 512m, worker-2 1 CPU / 512m

## Provenance

- Git SHA: [`d0550b0b580696680a576383a0243b14625a7b22`](https://github.com/fudi-mahfudin/integration-hub/commit/d0550b0b580696680a576383a0243b14625a7b22)
- `bigrun.commitments.json` SHA-256: `913abb09e781f29f26832984e73cb7945a08e5abe84f29807361f2feddc88e44`
- Its last commit: [`7fef1f2`](https://github.com/fudi-mahfudin/integration-hub/commit/7fef1f200a1494e7ffba07e05dda3bdcc5bcf7d9), 2026-11-27T18:33:32+07:00
