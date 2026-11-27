# Integration Hub

A hub that takes pharmacy events from a hospital's source system and delivers them to SATUSEHAT, Indonesia's national health platform (HL7 FHIR R4), so that each visit's effects land exactly once and in order.

## Source side

**Source system**:
The hospital information system that produces pharmacy events. It is simulated in this project.
_Avoid_: Client, upstream, HIS (when used generically)

**Visit**:
One patient encounter at the hospital as reported by the source system, identified by the source system's own visit number.
_Avoid_: Encounter (that is the SATUSEHAT record of a visit), admission, registration

**Source event**:
One fact reported by the source system about a visit, such as a prescription being written or a drug being dispensed.
_Avoid_: Message, request, payload

**Idempotency key**:
A value the source system attaches to a source event so that resending the event is recognised as the same event.
_Avoid_: Request ID, dedup key

**Duplicate ingest**:
A source event arriving again with an idempotency key the hub has already accepted from the same source system, while that key is still retained.
_Avoid_: Retry (that is the sender's act, not the hub's observation)

## Hub side

**Case**:
The hub's record of one visit, opened by the first source event the hub accepts for that visit. It supports exactly one prescription with exactly one drug item, and its dispense. A prescription with more than one drug item is rejected, so its case can never complete.
_Avoid_: Job, transaction, workflow, order

**Waiting case**:
A case whose next step cannot start because the source event it needs has not arrived. It stays visible, never silently lost.
_Avoid_: Stuck case, pending case

**Stalled case**:
A waiting case that has waited longer than a set threshold. It is flagged for an operator's attention; being stalled changes nothing about the case itself.
_Avoid_: Stuck case, expired case, timed-out case

**Abandoned case**:
A case an operator has deliberately ended without completing it, because it can no longer be completed. It is final. Only an operator abandons a case; time alone never does.
_Avoid_: Cancelled case, closed case, expired case

**Step**:
One ordered submission to SATUSEHAT within a case: create visit, submit prescription, submit dispense, update visit.
_Avoid_: Task, job, stage

**Current step**:
A case's earliest step that is not completed: the one its status is derived from. A completed case has none.
_Avoid_: Active step, next step

**Attempt**:
One try at carrying out a step. A step may take several attempts; a worker crashing mid-attempt still counts as one.
_Avoid_: Try, run, execution

**Step-time validation**:
The check the hub's Validation module makes on what a step has built, just before the step sends it. A payload with any violation is not sent: the step is dead-lettered with the first violation in rule order (`MAPPING_MISSING`, `KFA_LEVEL_INVALID`, `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`, `SUBSTITUTION_MISMATCH`, `PAYLOAD_INVALID`), and every violation goes to the attempt log.
_Avoid_: Ingest validation (that checks the source event and answers `422`), mock validation (that is the mock SATUSEHAT's own check, ADR 0006)

**Violation**:
One rule a step's payload breaks, found by step-time validation: a rule code, the FHIR path it concerns (if any), and a message naming the bad value.
_Avoid_: Error (ambiguous with failures), issue (that is an OperationOutcome's)

**Lookup method**:
How a person's IHS number was found for an attempt: by NIK, or one of the documented fallbacks. It is recorded in the attempt log.
_Avoid_: Match type, strategy

**Rejection log**:
The hub's record of the source events it rejected at ingest for a visit, keyed by (source system, `visitId`): each rejection's code, event type and time, never its body. It explains why a waiting case is still waiting, and never changes a case.
_Avoid_: Error log, attempt log (that is a step's record of its attempts), dead letter (that is a step's permanent failure)

**KFA details**:
What the hub knows about a KFA code: its level, its parent virtual product (for an actual product), its active ingredients as a set of 91 codes, its name and its dose form. Fetched from KFA v2 the first time a code is used and stored, shared by every source system.
_Avoid_: KFA cache (a cache may lose a value; KFA details are kept), KFA mapping (a mapping is the operator's local code → KFA code)

**Attempt log**:
A step's append-only record of its attempts: when each started and ended, its outcome, error code and HTTP status, the values it used, how each person was found, and every validation violation.
_Avoid_: Submission log (that is the mock SATUSEHAT's record of requests), history, audit log

**Pin**:
A value a completed step sent, such as a patient's IHS number or a Location ID, stored with its remote identifier in the same transaction. Later steps of the case read pins, never the live mappings or lookups.
_Avoid_: Snapshot, cache (a cache may lose a value; a pin is part of the case)

**Lease**:
A worker's time-limited claim on one step, taken when it starts an attempt. Only the worker holding the current lease may store the step's outcome; when a lease runs out, another worker may claim the step, and the first worker's late outcome is discarded.
_Avoid_: Lock (that is the database's, and lasts one transaction), reservation

**Retry**:
A further attempt the hub makes on its own after a transient failure, up to a fixed limit. When the limit is reached, the case is dead-lettered.
_Avoid_: Replay (that is an operator's deliberate action), resend (that is the source system's act)

**Read retry**:
Sending an idempotent read (a search or KFA lookup) again within one attempt after it failed transiently, at most twice. It is recorded under its attempt in the attempt log and is not itself an attempt. Writes are never read-retried.
_Avoid_: Retry (that is a further attempt), try

**Attempt budget**:
How long one attempt may go on making calls to SATUSEHAT. No call starts with less than one call timeout of it left; the attempt then ends transient, as `attempt_budget_exceeded`.
_Avoid_: Deadline, lease (that is the claim on a step)

**Dead-lettered case**:
A case whose step failed permanently. Its downstream steps are held and it waits for an operator to replay or abandon it.
_Avoid_: Failed case, poisoned case

**Replay**:
An operator action that resumes a dead-lettered case from its failed step.
_Avoid_: Retry (retries are automatic, replay is deliberate), rerun

**Effect-once**:
The guarantee that each step causes exactly one record at SATUSEHAT, however many times it is delivered or attempted.
_Avoid_: Exactly-once

**Duplicate submission**:
More than one record at SATUSEHAT caused by a single step (for the update visit step: more than one applied change). It breaks effect-once.
_Avoid_: Duplicate ingest (that is the same source event arriving twice at the hub), double post

**Mapping**:
A stored correspondence, kept by the operator, between a source system's local code and its national counterpart, such as a local drug code to a KFA code, or a local location code to a SATUSEHAT location. Patients and practitioners are not mapped: their IHS numbers are looked up for each visit.
_Avoid_: Lookup table, translation

**Reconciliation**:
A periodic or on-request check that compares cases at rest with their records at SATUSEHAT and reports every divergence. It only reports; it never changes a case.
_Avoid_: Sync, audit, repair

**Divergence**:
A disagreement between a case's local state and the matching record at SATUSEHAT, found by reconciliation.
_Avoid_: Drift, inconsistency

**Reconciliation run**:
One pass of reconciliation over the cases in its scope, requested by an operator or on a schedule and executed by one worker at a time. It checks each case once: the check is clean, finds divergences, is *skipped* (the case changed during its check, so nothing is compared) or is *unchecked* (a search at SATUSEHAT still failed, so nothing is known). Each divergence, skipped and unchecked case is a *finding* of the run.
_Avoid_: Sync job, audit, scan

## Platform side

**Remote identifier**:
The identifier SATUSEHAT assigns to a record the hub created. It is learned at runtime and stored, never hardcoded.
_Avoid_: FHIR ID, server ID

**Platform API**:
One of the three SATUSEHAT APIs the hub calls: FHIR, KFA v2, and the token endpoint (`auth`). Each has its own circuit breaker in every worker process; FHIR and KFA v2 each have one rate limit, shared by all worker processes.
_Avoid_: Upstream (avoided for the source system), host (against the mock, all three share one)

**Circuit breaker**:
A worker process's in-memory guard for one platform API. When at least half of the last 10s of its calls (20 or more) failed for the platform's health (5xx, timeouts, resets), it opens, and the worker claims no step until a probe call succeeds, so a down platform consumes no attempts.
_Avoid_: Kill switch, fuse

**IHS number**:
The SATUSEHAT identifier for a patient or practitioner.
_Avoid_: Patient ID, NIK (that is the national ID number, a different thing)

**KFA code**:
A code from the national drug dictionary (Kamus Farmasi dan Alat Kesehatan).
_Avoid_: Drug code (ambiguous with local codes)

**Virtual product (KFA 92)**:
A KFA code level that names a drug by ingredient, strength, and form, without a specific manufacturer's product. Allowed on a prescription.

**Actual product (KFA 93)**:
A KFA code level that names a specific marketed product. Required on a dispense.

**Substitution**:
A dispense whose actual product is neither the prescribed actual product nor one derived from the prescribed virtual product, but has exactly the same active ingredients, such as a different strength or a different brand. It is flagged as such on the dispense. A dispense with different active ingredients (a therapeutic substitution) is not supported. A dispense of the prescribed actual product, or of one derived from the prescribed virtual product, is *as prescribed*: no substitution.
_Avoid_: Replacement, swap

## Test side

**Fixture**:
A synthetic response that the mock SATUSEHAT sends in place of the real platform, success or error, filled with fake values. Each fixture records where its shape came from and whether that shape has been confirmed against the sandbox.
_Avoid_: Replay fixture (replay is an operator action on a dead-lettered case), recording (that is a real sandbox response, which is never committed)

**Submission log**:
The mock SATUSEHAT's record of every request it received, in arrival order, with what it answered and what it changed (created, updated, or nothing). Its report of invariant violations is computed from it.
_Avoid_: Request log, audit log, attempt log (that is the hub's record of its attempts)

**Visit key**:
The value of a visit's `encounter/{org}` identifier, which the mock SATUSEHAT uses to group a visit's requests in its submission log.
_Avoid_: Visit ID (that is the source system's field), Encounter ID (that is the remote identifier)

**Fault rule**:
A rule set on the mock SATUSEHAT that makes the requests it matches fail, slow down or wait, on a deterministic schedule fixed by a seed, so that the same run meets the same faults however workers interleave.
_Avoid_: Chaos, failure injection setting

**Hold**:
A request the mock SATUSEHAT has parked under a fault rule, unapplied and unanswered, until a test releases it, so a test can act at a known moment without sleeping.
_Avoid_: Pause, breakpoint, lock

**Business identifier**:
The `system|value` identifier the hub gives a record it submits, such as `encounter/{org}|V-1`, by which SATUSEHAT can be searched for it. ADR 0005 calls it the local identifier.
_Avoid_: Remote identifier (that is the id SATUSEHAT assigns), external ID


The one synthetic set of fake national records (KFA products, patients, practitioners, locations and the organization) that the mock SATUSEHAT answers from, the source simulator draws visits from, and the hub's mapping seed points at. It includes deliberate near-miss patients for the lookup fallbacks and canary values for redaction tests. Its size is a big-run commitment.
_Avoid_: Test data, fixtures (a fixture is a response, not a record), seed data (seeding adds to the world until the next reset)

**Contract check**:
A manual comparison of how the real SATUSEHAT sandbox and the mock SATUSEHAT answer the same requests, by shape only (status, headers, fields and their types), never by value. It is how a change in the real platform is noticed.
_Avoid_: Drift check (drift is avoided for divergence), integration test

**Live check**:
A manual run of a fixed set of fictional cases through the whole hub against the real SATUSEHAT sandbox, confirming that each case's effects land there as expected. Where a contract check asks whether the answers have the right shape, a live check asks whether a visit actually gets delivered.
_Avoid_: Smoke test, integration test, sandbox run

**Big run**:
The fixed, published run of 10,000 source events, a fifth of them duplicates, with platform failures injected, whose commitments are fixed before any result. It passes only if no event is lost, nothing is submitted twice, and every case keeps its order.
_Avoid_: Load test, stress test, benchmark

**Load test**:
A run that measures how fast the hub accepts source events under a fixed arrival rate, with no injected failures, against thresholds fixed beforehand.
_Avoid_: Big run, benchmark

**Cache run**:
A fixed set of paired runs, with no injected failures, that compares the hub with and without a cache to decide whether that cache stays. Its commitments are fixed before any result, and a cache that doesn't clear the agreed bar is removed.
_Avoid_: Big run, load test, benchmark
