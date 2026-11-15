# Postgres transactional outbox as the queue; no message broker

Steps are enqueued in the same Postgres transaction as the case state change that makes them eligible, and workers claim them with row locks that skip already-claimed rows, under a lease so a crashed worker's step becomes claimable again. A broker (Kafka, RabbitMQ, SQS) would split the state change and the enqueue across two systems and reintroduce the dual-write problem the outbox exists to avoid, while the throughput target (a 10,000-event run) is well within what Postgres handles.

## Considered Options

- **Kafka or RabbitMQ**: rejected; dual write between database and broker, plus an extra component outside the closed list.
- **Redis queue**: rejected; Redis may lose data by design in this system (see ADR 0003).

## Consequences

- Locking and transactions must stay visible in the code, which is why data access uses a query builder (Kysely) rather than an ORM that hides them.
