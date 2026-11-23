# Cases end only by completion or by an operator abandoning them

A case can stop moving for good: it waits for a source event that never comes, or it is dead-lettered because its source data is wrong, and source events are immutable. Such a case ends only when an operator abandons it (a final `abandoned` status, with a mandatory note). Time never ends a case: a waiting case past a threshold is only flagged as stalled. Abandoning sends nothing to SATUSEHAT; records created by completed steps are left in place and listed on the case.

## Considered Options

- **Automatic expiry of waiting cases**: rejected. A waiting case can still recover (a corrected prescription resend is accepted because its key was never consumed), and wall-clock time would become a source of state changes during the big run.
- **No terminal status, stalled cases flagged forever**: rejected. Cases nobody can clear pile up, and "zero lost events" has no clear answer for them.
- **A compensating "close visit" step on abandon** (e.g. marking the Encounter `cancelled`): rejected. It adds a step type, another write that must be effect-once, and a new failure mode for the step that is meant to end failures. Cleaning up records at SATUSEHAT is a hospital operations task.

## Consequences

- An accepted event counts as accounted for when its step is completed, dead-lettered, or abandoned with a recorded reason; "lost" means accepted with no visible disposition.
- No operator acts during the big run, so any `abandoned` case in its results fails the zero-lost-events invariant. Abandonment cannot be used to hide failures.
- Reconciliation treats an abandoned case's completed steps as expected remote records, and any remote record for an abandoned step as divergence.
- Partial records left at SATUSEHAT are a deliberate limitation, stated in the README.
