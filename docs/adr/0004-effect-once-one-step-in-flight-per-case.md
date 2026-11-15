# Claim effect-once, serialised per case: one step in flight per case

The hub claims effect-once (each step causes exactly one record at SATUSEHAT, verified by the mock counting submissions), not exactly-once delivery, which no network path can promise. Each visit is one case with ordered steps; a step becomes eligible only when its predecessor completed and its remote identifiers are stored, only one step per case is ever in flight, and different cases run in parallel. A permanently failed step dead-letters only its own case.

## Considered Options

- **Exactly-once delivery**: rejected as an unprovable claim.
- **One case per drug item, sharing the visit**: rejected. Cases would share the create-visit and update-visit steps, so per-case serialisation would no longer prevent concurrent duplicate visit records, the visit update would need a join across cases, and one failing item would block its healthy siblings. Instead, a visit with more than one drug item is rejected at ingest as unsupported.

## Consequences

- Out-of-order source events are stored on arrival but steps are released strictly in order, so a case can wait on a missing source event; such waiting cases must be visible to operators.
