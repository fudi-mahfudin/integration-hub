# Modular monolith with a separate worker process, not microservices

The hub is one NestJS codebase with explicit module boundaries (Ingestion, Case Orchestration, Outbox and Worker, SATUSEHAT Adapter, Mapping and Lookup, Validation, Reconciliation, Observability), deployed as the hub service (the HTTP API) and a worker process. At this scale microservices would add network hops, distributed transactions, and deployment surface without solving any problem the project has; the guarantees it wants to show (idempotency, ordering, effect-once) are easiest to prove when the state they depend on lives in one database behind one transaction boundary.

## Consequences

- The source simulator and the mock SATUSEHAT are separate programs because they stand in for external systems, not because the hub is split.
- The README must explain why microservices were rejected, since reviewers may expect them.
