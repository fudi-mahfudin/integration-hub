# Source simulator

Stands in for the hospital's source system. It plans a seeded batch of fictional visits from the mock SATUSEHAT's world dataset, sends their source events to the hub, checks every answer, and waits until every case completes.

`pnpm stack:up` runs it in compose (see the [README](../../README.md#quick-start)). To run it on the host against a hub on `localhost:3000`:

```sh
pnpm --filter @integration-hub/simulator start
```

It exits 0 when every check held, and 1 after printing each failed check. Its checks:

- Every original send gets `202`. Every duplicate gets `202` with `Idempotent-Replayed: true` and the original's body. Of a concurrent pair, exactly one is fresh.
- Every case completes within `SIM_COMPLETION_TIMEOUT_MS` of the last original send. A `dead_lettered` or `abandoned` case fails the batch.

## What a batch holds

Each visit has the four source events: `visit.started`, `prescription.written` (one item), `drug.dispensed` (always with a batch lot and expiry date) and `visit.finished`. Patients are drawn uniformly from the world's patients, physicians from its physicians, and the pharmacist from its pharmacists. Drugs and clinics come from the simulator's own local codes (`src/local-codes.ts`), which the hub's mapping seed (`apps/hub/seed`) maps to the world's KFA codes and locations; a test keeps the three in step.

Every share is a share of visits, applied as an exact count chosen by the seed:

- **Substitution.** The dispense is another actual product (93) with exactly the same active ingredients, declared with a reason code. Every other visit is dispensed as prescribed: the prescribed 93, or a 93 derived from the prescribed 92.
- **Fallback lookup.** The patient is sent with mother's NIK + birthDate, or with name + birthDate + gender, and no NIK. The simulator only picks a fallback that finds exactly that patient, never one of the world's deliberate near-misses.
- **Out of order.** One event is sent before its predecessor, which is held back for at least the delay. The case waits, then recovers.
- **Duplicates.** A share of the events is sent again with the same `Idempotency-Key` and byte-identical body. Each is sent with the original (concurrent), 0.5–10s after the original's `202` (delayed), or after the case completed (late).

Original sends follow an open loop at a fixed arrival rate: they don't slow down when the hub does. The same seed and settings plan the same batch. Only the run id differs between runs: it prefixes visit ids and idempotency keys so that batches sent to one hub never collide.

## Settings (environment)

| Variable | Default | What |
|---|---|---|
| `HUB_URL` | `http://localhost:3000/` | The hub service |
| `SIMULATOR_API_KEY` | `dev-source-key` | The source system's API key (the hub's public development source, `simulator`) |
| `SIM_SEED` | `44` | Fixes every draw |
| `SIM_RUN_ID` | from the clock | 1-16 letters or digits; prefixes visit ids (`V-<runId>-00001`) and idempotency keys |
| `SIM_VISITS` | `20` | Visits in the batch |
| `SIM_EVENTS_PER_SECOND` | `10` | Arrival rate of original sends |
| `SIM_OUT_OF_ORDER_SHARE` / `SIM_OUT_OF_ORDER_DELAY_MS` | `0.1` / `2000` | Out-of-order visits, and how long the held-back event waits at least |
| `SIM_SUBSTITUTION_SHARE` | `0.1` | Substitution visits |
| `SIM_FALLBACK_LOOKUP_SHARE` | `0.1` | Fallback-lookup visits |
| `SIM_DUPLICATES_PER_EVENT` | `0.25` | Share of events (0-1) that get one duplicate |
| `SIM_DUPLICATES_CONCURRENT` / `_DELAYED` / `_LATE` | `0.5` / `0.3` / `0.2` | How the duplicates are timed; must sum to 1 |
| `SIM_DUPLICATE_DELAY_MIN_MS` / `_MAX_MS` | `500` / `10000` | The window of a delayed duplicate after the original's `202` |
| `SIM_POLL_INTERVAL_MS` | `1000` | How often an unfinished case is read |
| `SIM_COMPLETION_TIMEOUT_MS` | `300000` | How long the cases may take to complete after the last original send |

The shares and duplicate timings default to the big run's ratios (`bigrun.commitments.json`).
