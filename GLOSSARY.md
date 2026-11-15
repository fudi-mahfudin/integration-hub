# Integration Hub

A hub that takes pharmacy events from a hospital's source system and delivers them to SATUSEHAT, Indonesia's national health platform (HL7 FHIR R4), so that each visit's effects land exactly once and in order.

## Source side

**Source system**:
The hospital information system that produces pharmacy events. It is simulated in this project.
_Avoid_: Client, upstream, HIS (when used generically)

**Source event**:
One fact reported by the source system about a visit, such as a prescription being written or a drug being dispensed.
_Avoid_: Message, request, payload

**Idempotency key**:
A value the source system attaches to a source event so that resending the event is recognised as the same event.
_Avoid_: Request ID, dedup key

**Duplicate ingest**:
A source event arriving again with an idempotency key the hub has already accepted from the same source system.
_Avoid_: Retry (that is the sender's act, not the hub's observation)

## Hub side

**Case**:
The hub's record of one visit: exactly one prescription with exactly one drug item, and its dispense. A visit with more than one drug item is unsupported and is not a case.
_Avoid_: Job, transaction, workflow, order

**Step**:
One ordered submission to SATUSEHAT within a case: create visit, submit prescription, submit dispense, update visit.
_Avoid_: Task, job, stage

**Dead-lettered case**:
A case whose step failed permanently. Its downstream steps are held and it waits for an operator to replay it.
_Avoid_: Failed case, poisoned case

**Replay**:
An operator action that resumes a dead-lettered case from its failed step.
_Avoid_: Retry (retries are automatic, replay is deliberate), rerun

**Effect-once**:
The guarantee that each step causes exactly one record at SATUSEHAT, however many times it is delivered or attempted.
_Avoid_: Exactly-once

**Mapping**:
A stored correspondence between a local identifier and its national counterpart, such as a local drug code to a KFA code, or a patient to an IHS number.
_Avoid_: Lookup table, translation

**Divergence**:
A disagreement between a case's local state and the matching record at SATUSEHAT, found by reconciliation.
_Avoid_: Drift, inconsistency

## Platform side

**Remote identifier**:
The identifier SATUSEHAT assigns to a record the hub created. It is learned at runtime and stored, never hardcoded.
_Avoid_: FHIR ID, server ID

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
A dispense whose product differs in strength from what was prescribed while keeping the same active ingredient, flagged as such on the dispense.
_Avoid_: Replacement, swap
