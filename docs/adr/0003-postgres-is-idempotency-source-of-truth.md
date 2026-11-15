# Postgres is the source of truth for idempotency; Redis is only a fast path

A duplicate ingest is detected by a uniqueness constraint over source identity plus idempotency key in Postgres. Redis may front this as a fast path but may lose any key at any time without affecting correctness. A Redis-only check-then-set looks correct and passes sequential tests but races under concurrent duplicates; the project keeps a clearly labelled naive Redis-only implementation with a red race test next to the real one to show this.

## Consequences

- No cache in the system is allowed to be load-bearing for correctness, and none is added without a measured before-and-after.
