# Hub API contract

The HTTP API the hub service offers to source systems. Domain terms are in [GLOSSARY.md](../GLOSSARY.md). This file grows as tickets land; it describes only what the hub does today.

## Authentication

Every request carries `Authorization: Bearer <api key>`. Each source system has one static API key. The source system's identity, and the SATUSEHAT organization it belongs to, come from the key, never from the request body. A missing, malformed or unknown key is [`401 UNAUTHENTICATED`](#unauthenticated).

The operator has one more static key, the **admin API key** (`HUB_ADMIN_API_KEY`; there is no user model, ADR 0001). Only it may call the operator endpoints ([replay](#post-v1casesidreplay), [abandon](#post-v1casesidabandon), [mapping administration](#put-v1adminmappingsdrugslocationslocalcode)); a source system's key there is [`403 FORBIDDEN`](#forbidden). It may also read any source system's case.

## `POST /v1/events`

Sends one source event.

### Headers

| Header | Rules |
|---|---|
| `Authorization` | `Bearer <api key>` |
| `Idempotency-Key` | Required. An opaque string of 1-255 characters; it doesn't have to be a UUID. Missing: [`400 IDEMPOTENCY_KEY_MISSING`](#idempotency_key_missing). Empty or longer than 255: [`400 IDEMPOTENCY_KEY_INVALID`](#idempotency_key_invalid). |

### Order of checks

1. Authenticate (`401`).
2. `Idempotency-Key` present and valid (`400`).
3. Key lookup: a key already accepted from this source system with the same body is a duplicate ingest and gets the original answer again; with a different body it is [`422 IDEMPOTENCY_KEY_REUSED`](#idempotency_key_reused).
4. Event schema ([`422 VALIDATION_FAILED`](#validation_failed)), then a prescription's item count ([`422 UNSUPPORTED_MULTI_ITEM`](#unsupported_multi_item)).
5. Checks against the visit's case: an operator abandoned it ([`409 CASE_ABANDONED`](#case_abandoned)); then against events already recorded for the visit ([`409 EVENT_ALREADY_RECORDED`](#event_already_recorded), [`422 UNSUPPORTED_MULTI_ITEM`](#unsupported_multi_item) for a second prescription item, [`422 PRESCRIPTION_MISMATCH`](#prescription_mismatch) when a prescription and its dispense name different items, or [`422 FINISHED_BEFORE_STARTED`](#finished_before_started) when a visit's `finishedAt` is not later than its `startedAt`).
6. Accept (`202`).

A true duplicate always gets the original answer. It is never validated again into a different answer.

### Envelope

```json
{
  "type": "visit.started",
  "visitId": "V-2026-000123",
  "occurredAt": "2026-03-02T08:00:00+07:00",
  "data": { }
}
```

| Field | Rules |
|---|---|
| `type` | The event type: `visit.started`, `prescription.written`, `drug.dispensed` or `visit.finished`. |
| `visitId` | The source system's own visit number, 1-64 characters, unique per source system. The case for the visit is keyed by (source system, `visitId`). |
| `occurredAt` | When the event happened at the source. A time (see [Times](#times)). |
| `data` | The event's fields, by `type`. |

Unknown fields are ignored.

### `visit.started`

| Field | Rules |
|---|---|
| `patient` | `{ nik?, motherNik?, name?, birthDate?, gender?, mrn }`. Must carry one of: `nik`; `motherNik` + `birthDate`; `name` + `birthDate` + `gender`. `mrn` (the hospital's medical record number, 1-64 characters) is always required. |
| `practitioner` | `{ nik }` or `{ name, birthDate, gender }`. |
| `encounterClass` | `AMB`, `IMP` or `EMER`. |
| `locationCode` | The hospital's local location code, 1-64 characters. |
| `startedAt` | A time (see [Times](#times)), not before the date floor. |

`nik` and `motherNik` are 16 digits. `birthDate` is a calendar date `YYYY-MM-DD`. `gender` is `male` or `female`. `name` is 1-200 characters.

### `prescription.written`

| Field | Rules |
|---|---|
| `prescriptionId` | The source's prescription number, 1-64 characters. It becomes the `prescription/{org}` identifier. |
| `authoredAt` | A time (see [Times](#times)), not before the date floor. |
| `requester` | The prescribing practitioner: `{ nik }` or `{ name, birthDate, gender }`, as for `visit.started`. |
| `items` | Exactly one item (see below). Any other count, including none, is [`422 UNSUPPORTED_MULTI_ITEM`](#unsupported_multi_item), checked once the schema passes. |

Each item is `{ itemId, drugCode, quantity, dosage }`:

| Field | Rules |
|---|---|
| `itemId` | The source's item number, 1-64 characters. It becomes the `prescription-item/{org}` identifier. |
| `drugCode` | The hospital's **local** drug code, 1-64 characters. The hub maps it to a KFA code; the source never sends KFA codes. |
| `quantity` | How much to dispense, a number greater than 0. No unit: the hub counts it in the mapped KFA product's dose form. |
| `dosage` | `{ text, timesPerDay, doseAmount, routeCode }`: `text` 1-500 characters, `timesPerDay` a whole number greater than 0, `doseAmount` a number greater than 0 (in the dose form), `routeCode` 1-16 characters (for example `O`, oral). |

A case supports one prescription with one drug item (ADR 0004). A second `prescription.written` for the visit with another `prescriptionId` or `itemId` is `422 UNSUPPORTED_MULTI_ITEM`; with the same pair it is `409 EVENT_ALREADY_RECORDED`. A prescription may arrive before its `visit.started`: it is stored, and submitted once the visit's Encounter exists.

### `drug.dispensed`

| Field | Rules |
|---|---|
| `prescriptionId`, `itemId` | The prescription and item this dispense fills, 1-64 characters each: the same pair as the visit's `prescription.written`. |
| `drugCode` | The hospital's **local** code of the product actually handed over, 1-64 characters. The hub maps it to a KFA code, which must be an actual product (93). |
| `quantity` | How much was handed over, a number greater than 0, counted in the dispensed KFA product's dose form. |
| `preparedAt`, `handedOverAt` | Times (see [Times](#times)), not before the date floor. |
| `pharmacist` | The dispensing pharmacist: `{ nik }` or `{ name, birthDate, gender }`, as for `visit.started`. |
| `batch` | Optional: `{ lot, expiry }`, both or neither (`BATCH_INCOMPLETE`); for neither, leave `batch` out, since an empty `batch` is incomplete too. `lot` is 1-64 characters; `expiry` is a calendar date `YYYY-MM-DD`, sent on as written and not before `2014-06-03`. |
| `substitution` | Optional: `{ reasonCode }` when the source dispensed a substitute. `reasonCode` is one of `OS` (out of stock), `FP` (formulary policy), `DRUG_INTERACTION`, `PATIENT_CHOICE`, `PRESCRIPTION_ERROR`; anything else is `INVALID_SUBSTITUTION_REASON`. |

A dispense and its prescription may arrive in either order. Whichever arrives second must name the same `prescriptionId` and `itemId` as the first, or it is [`422 PRESCRIPTION_MISMATCH`](#prescription_mismatch). A second `drug.dispensed` for the visit is `409 EVENT_ALREADY_RECORDED`. The dispense is submitted once the prescription's MedicationRequest exists.

**Substitution.** The hub decides from KFA, never from local codes, whether a dispense is a substitution. The prescribed product is the one submit prescription pinned. Dispensing that product, or an actual product derived from the prescribed virtual product (92), is no substitution. Dispensing another product whose active ingredients (its set of KFA 91 codes) are exactly the same, such as another strength or another brand, is a substitution. The MedicationDispense then says so: type `G`, the reason, and the requester and pharmacist as responsible. A product with other active ingredients is a therapeutic substitution, which is not supported. The source's `substitution` must agree with the hub's decision in both directions. Disagreement dead-letters the case at the dispense step (see [Dead-letter reasons](#dead-letter-reasons)); it is not an ingest rejection.

### `visit.finished`

| Field | Rules |
|---|---|
| `finishedAt` | When the visit ended. A time (see [Times](#times)), not before the date floor. |

A visit's two events may arrive in either order. Whichever arrives second is checked against the first: `finishedAt` must be later than `startedAt`, compared as instants truncated to the second (as SATUSEHAT takes them), or it is [`422 FINISHED_BEFORE_STARTED`](#finished_before_started). A second `visit.finished` for the visit is `409 EVENT_ALREADY_RECORDED`. The visit's Encounter is updated once the dispense has been submitted, and the case is then `completed`.

**Update visit.** The hub sends the Encounter create visit stored again, `PUT Encounter/{id}`, with `status: finished` and `period.end`, using the patient, practitioner and Location create visit pinned. `Encounter.diagnosis` is not sent (see the README's known risks). It first searches the visit's `encounter/{org}` identifier: if the Encounter there is already finished at the same end, an earlier attempt's update landed, and the hub adopts it instead of sending it again. The step stores the Encounter's new `meta.versionId`.

### Times

- Times are ISO 8601 date-times with an explicit offset, for example `2026-03-02T08:00:00+07:00` or `2026-03-02T01:00:00Z`. Seconds and fractions are optional. A time without an offset, or only part of one (for example just a date), is `TIME_OFFSET_MISSING`.
- The date floor is `2014-06-03T00:00:00+00:00`, compared on the UTC value. `2014-06-03T05:00:00+07:00` is before it (`DATE_BEFORE_FLOOR`). It applies to `startedAt`, `finishedAt`, `authoredAt`, `preparedAt` and `handedOverAt`, not to `occurredAt`. A `batch.expiry` is a plain date and is never converted; it must not be before `2014-06-03`.

### `202 Accepted`

```json
{ "visitId": "V-2026-000123", "type": "visit.started", "caseStatus": "active" }
```

`Location: /v1/cases/{caseId}` names the case. `caseStatus` is the case status at the moment the event was accepted. Ask [`GET /v1/cases/{id}`](#get-v1casesid) for the current status. Ingest never waits for SATUSEHAT.

### Idempotency

- **Duplicate ingest.** The same source system, the same `Idempotency-Key` and the same body get the original status and body back verbatim, plus `Idempotent-Replayed: true`. "Same body" means the same SHA-256 fingerprint of the RFC 8785 canonical JSON, so key order and whitespace don't matter.
- **Same key, different body**: [`422 IDEMPOTENCY_KEY_REUSED`](#idempotency_key_reused). Nothing is recorded.
- **Only a `202` consumes a key.** After a `400`, `401`, `409` or `422` nothing is recorded, and the same key may be sent again, for example with a corrected body.
- **Concurrent identical requests** open exactly one case and all get the same answer.
- **Retention.** An accepted key is kept for **at least 24 hours**, then deleted by a periodic purge (hourly by default). Until it is purged, a resend still gets the original answer. After that, an identical resend gets [`409 EVENT_ALREADY_RECORDED`](#event_already_recorded) instead. The event is still recorded once; only the answer differs.

## `GET /v1/cases/{id}`

A case's status, what a waiting case waits for, what an operator did to it, and its four steps in order. A source system sees only its own cases; any other id is [`404 NOT_FOUND`](#not_found). The admin API key sees every case.

```json
{
  "caseId": "0b6f6c1e-8a0e-4d55-9b4b-3f1f1d7f2a10",
  "visitId": "V-2026-000123",
  "status": "waiting",
  "waitingFor": "prescription.written",
  "waitingSince": "2026-03-02T01:00:03.120Z",
  "stalled": false,
  "deadLetterReason": null,
  "reasonClass": null,
  "deadLetteredSince": null,
  "replayCount": 0,
  "replays": [],
  "abandonment": null,
  "rejections": [
    { "code": "UNSUPPORTED_MULTI_ITEM", "eventType": "prescription.written", "rejectedAt": "2026-03-02T01:05:41.002Z" }
  ],
  "steps": [
    {
      "step": "create_visit", "eventType": "visit.started", "state": "completed", "attempts": 1, "deadLetterReason": null, "availableAt": null,
      "remote": { "type": "Encounter", "id": "5f8d2c8e-7a51-4b0e-9a57-0d7c3f1e9b42", "version": "1" },
      "pins": { "patientIhsNumber": "P00000000001", "practitionerIhsNumber": "10000000001", "locationId": "b017aa54-f1df-4ec2-9d84-8823815d7228" },
      "attemptLog": [
        {
          "attempt": 1, "startedAt": "2026-03-02T01:00:03.140Z", "endedAt": "2026-03-02T01:00:03.410Z",
          "outcome": "completed", "errorCode": null, "httpStatus": 201,
          "valuesUsed": { "locationId": "b017aa54-f1df-4ec2-9d84-8823815d7228", "patientIhsNumber": "P00000000001", "practitionerIhsNumber": "10000000001" },
          "lookupMethods": { "patient": "nik", "practitioner": "nik" },
          "violations": [],
          "readRetries": [{ "call": "GET /fhir-r4/v1/Encounter", "try": 1, "failure": "status", "httpStatus": 503 }]
        }
      ]
    },
    { "step": "submit_prescription", "eventType": "prescription.written", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "availableAt": null, "remote": null, "pins": null, "attemptLog": [] },
    { "step": "submit_dispense", "eventType": "drug.dispensed", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "availableAt": null, "remote": null, "pins": null, "attemptLog": [] },
    { "step": "update_visit", "eventType": "visit.finished", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "availableAt": null, "remote": null, "pins": null, "attemptLog": [] }
  ]
}
```

Case status: `waiting`, `active`, `dead_lettered`, `completed`, `abandoned`. Step state: `awaiting_event`, `blocked`, `ready`, `in_flight`, `retry_wait`, `completed`, `dead_lettered`, `abandoned`.

| Field | Meaning |
|---|---|
| `waitingFor` | For a `waiting` case, the source event its next step needs; otherwise `null`. |
| `waitingSince` | Since when a `waiting` case has waited for `waitingFor` (UTC); otherwise `null`. |
| `stalled` | `true` for a `waiting` case that has waited (since `waitingSince`) longer than the stalled threshold, `STALLED_AFTER_MS` (default 24h), as of the read. It only flags the case for an operator; time never changes a case (ADR 0007). Always `false` for any other status. |
| `deadLetterReason` | For a `dead_lettered` case, the reason its failed step was dead-lettered; otherwise `null`. |
| `reasonClass` | For a `dead_lettered` case, what an operator can do about the reason: `replayable` (fix the cause outside the case, then [replay](#post-v1casesidreplay)) or `source_data` (the source events themselves are wrong, so [abandoning](#post-v1casesidabandon) is suggested); otherwise `null`. See [Dead-letter reasons](#dead-letter-reasons). Replay is never refused because of it. |
| `deadLetteredSince` | Since when a `dead_lettered` case has been dead-lettered (UTC); otherwise `null`. |
| `replayCount` | How many times an operator has replayed the case. |
| `replays` | Every operator replay of the case, oldest first: the `step` replayed, the dead-letter `reason` it cleared, the operator's `note` (or `null`) and `replayedAt`. |
| `abandonment` | For an `abandoned` case: the operator's `note`, `abandonedAt`, the `previousStatus` (`waiting` or `dead_lettered`), the `waitingFor` or `deadLetterReason` it had then (the other is `null`), and `remoteRecordsLeft`, the records its completed steps left at SATUSEHAT (`[{ step, type, id, version }]`). Otherwise `null`. |
| `rejections` | The rejection log of the visit: every `VALIDATION_FAILED`, `UNSUPPORTED_MULTI_ITEM`, `PRESCRIPTION_MISMATCH`, `FINISHED_BEFORE_STARTED`, `EVENT_ALREADY_RECORDED` and `CASE_ABANDONED` answer to an event naming this `visitId` and an event type, oldest first, including those sent before the case opened. Only the code, the event type and the time are kept, never the body. It explains a waiting case and never changes it. |
| `steps[].attempts` | How many times a worker has claimed the step. A replay doesn't reset it: attempt numbers go on from it. |
| `steps[].remote` | The record the step stored at SATUSEHAT, by its remote identifier and `meta.versionId`; `null` until the step completes. |
| `steps[].deadLetterReason` | Why the step was dead-lettered; `null` unless it was. A step abandoned while dead-lettered keeps it. |
| `steps[].availableAt` | For a step in `retry_wait`, when a worker may claim it again (UTC); otherwise `null`. See [Retries](#retries). |
| `steps[].pins` | The values the step sent, pinned when it completed; later steps read these, never the live mappings or lookups. Create visit pins `patientIhsNumber`, `practitionerIhsNumber` and `locationId`. Submit prescription pins the prescribed KFA product (`kfaCode`, `kfaLevel`, `parent92`, `activeIngredients`, its 91 codes) and `requesterIhsNumber`. Submit dispense pins the dispensed KFA product (the same four fields) and `pharmacistIhsNumber`. Update visit pins the create visit values it sent again. `null` until the step completes. |
| `steps[].attemptLog` | Every attempt at the step, oldest first. Append-only. |
| `attemptLog[].outcome` | `completed`; `dead_lettered`; `failed` (it failed transiently: the step waits in `retry_wait`, or, if this was its last allowed attempt, is dead-lettered with `errorCode` `RETRIES_EXHAUSTED`); `attempt_budget_exceeded` (it had less time left than one call may take, so it stopped; transient, like `failed`); `lease_expired` (its lease ran out before it stored an outcome, and another attempt took the step over; it ended when the lease ran out, and an outcome it reaches later is thrown away); `discarded` (no longer written: shown only on attempts logged before `lease_expired` existed, whose late outcome was thrown away). |
| `attemptLog[].errorCode` | The dead-letter reason the attempt reached (`RETRIES_EXHAUSTED` on a transient last attempt); otherwise `null`. |
| `attemptLog[].httpStatus` | The status of the last SATUSEHAT response the attempt read; `null` if it sent nothing. |
| `attemptLog[].valuesUsed`, `lookupMethods` | What the attempt had resolved, as far as it got (the values its step pins), and how each person was found: `nik`, `mother_nik_birth_date` or `name_birth_date_gender`. A person the attempt did not find has no entry. IHS numbers are looked up on every attempt, never reused from another case. |
| `attemptLog[].httpStatus` for KFA | A KFA v2 lookup that still answers a 5xx or times out on its third try ends the attempt as `failed`: transient, never a dead letter. |
| `attemptLog[].violations` | Every violation step-time validation found, in rule order, each with `code`, `path` (a FHIR path, or `null`) and `message`. The dead-letter reason is the first one. |
| `attemptLog[].readRetries` | The attempt's read retries: each read (a search or KFA lookup) that failed transiently and was sent again within the attempt, with the `call` (method and path, never the query), which `try` failed (1 or 2), how (`status`, `timeout` or `network`) and the `httpStatus` answered. They are not attempts. |

### Dead-letter reasons

Just before a step sends anything, step-time validation checks what it built. Any violation dead-letters the step and sends nothing. The case becomes `dead_lettered` and its later steps are held. The validation codes, in rule order:

| Code | Meaning |
|---|---|
| `MAPPING_MISSING` | A local code the step needs has no mapping for this source system (for create visit, the visit's `locationCode`; for submit prescription, the item's `drugCode`; for submit dispense, the dispense's `drugCode`), or the drug code maps to a KFA code that KFA v2 does not know (it answers no result, or `404`). Nothing was sent. |
| `KFA_LEVEL_INVALID` | The mapped KFA product has the wrong level: a prescription needs a 92 or 93, a dispense a 93. |
| `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION` | The dispensed product's active ingredients (its set of KFA 91 codes) differ from the prescribed product's. |
| `SUBSTITUTION_MISMATCH` | Whether the dispense is a substitution, as judged from KFA, disagrees with the source's `substitution` declaration: a declared substitution that is none, or a substitution that wasn't declared. |
| `PAYLOAD_INVALID` | The built payload breaks a mandatory-field, time-format, date-floor or identifier-system rule: a hub bug. The details are in the attempt log. |

`UNSUPPORTED_THERAPEUTIC_SUBSTITUTION` and `SUBSTITUTION_MISMATCH` come from bad source data: replaying the case can't fix them. Lookups and search-then-create can also dead-letter a step:

| Code | Meaning |
|---|---|
| `PATIENT_NOT_FOUND` | No search the visit's `patient` supplies data for found anyone. The hub tries them in the order SATUSEHAT documents: `nik`; then `motherNik`, keeping only the children born on `birthDate`; then `name` + `birthDate` + `gender`. A search that finds no one moves on to the next. The hub never creates a Patient. |
| `PATIENT_AMBIGUOUS` | One of those searches found more than one patient, for example twins found by their mother's NIK and birth date. The hub stops there: a later, weaker search never decides between them. |
| `PRACTITIONER_NOT_FOUND` | Neither `nik` nor `name` + `birthDate` + `gender` found anyone for the visit's `practitioner`, the prescription's `requester` or the dispense's `pharmacist`. |
| `PRACTITIONER_AMBIGUOUS` | One of those searches found more than one practitioner. |
| `REMOTE_RECORD_AMBIGUOUS` | More than one record at SATUSEHAT already carries the step's identifier (for create visit, `encounter/{org}` with the `visitId`; for submit prescription and submit dispense, `prescription/{org}` with the `prescriptionId`, which a MedicationDispense reuses), so the hub can't tell which one is the visit's. |
| `REMOTE_RECORD_MISSING` | The visit's Encounter is gone from SATUSEHAT: update visit's search by `encounter/{org}` finds no record. |

SATUSEHAT's answers can dead-letter a step too:

| Code | Meaning |
|---|---|
| `PLATFORM_FORBIDDEN` | SATUSEHAT answered `403`: the hub's credentials or configuration don't allow the call. Replay once that is fixed. |
| `PAYLOAD_INVALID` | SATUSEHAT answered another `4xx` the hub can't retry its way past (`400`, `404` on a search or create, `409`, `412`, `422`, …): a hub bug, as above. |
| `RETRIES_EXHAUSTED` | The step's 15th attempt since it was last replayed failed transiently too (or its lease ran out). |

Each reason has a class, shown as the case's `reasonClass`:

| Class | Reasons |
|---|---|
| `replayable` | `MAPPING_MISSING`, `KFA_LEVEL_INVALID`, `RETRIES_EXHAUSTED`, `PLATFORM_FORBIDDEN`, `PATIENT_NOT_FOUND`, `PRACTITIONER_NOT_FOUND`, `PAYLOAD_INVALID`, `REMOTE_RECORD_MISSING`, `REMOTE_RECORD_AMBIGUOUS` |
| `source_data` | `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`, `SUBSTITUTION_MISMATCH`, `PATIENT_AMBIGUOUS`, `PRACTITIONER_AMBIGUOUS` |

### Retries

An attempt that fails transiently (a timeout, a network error or reset, any `5xx`, `408`, `429`, or a `401` that one token refresh didn't cure) sends its step to `retry_wait`. A worker claims it again at `availableAt`: after a random wait of up to `min(60s, 1s·2ⁿ⁻¹)` after attempt n, or the answer's `Retry-After` if that is later (capped at 300s; a past or unreadable value is ignored). Each attempt starts over with search-then-create, so a write SATUSEHAT applied but didn't answer is found and adopted, never sent twice. A read (search or KFA lookup) that fails transiently is retried within the attempt, after 100ms and then 400ms, and shows in `readRetries`; a write is never sent twice by one attempt. If update visit's stored Encounter id is stale (its search finds one other Encounter, or its `PUT` answers `404` or `410` and a search finds one), create visit's `remote` is refreshed to the one found and the step retried.

## `POST /v1/cases/{id}/replay`

Admin API key only. Resumes a `dead_lettered` case from its failed step. The body is optional: `{ "note": "drug mapping added" }` (a non-blank `note` of up to 2000 characters, or `null`).

- The failed step becomes `ready` again with no current dead-letter reason, and its attempt cap counts from 0. Its attempt numbers go on from the last one; the attempt log, the replays before, the completed steps with their remote identifiers and pins, and the states of the later steps are kept. The case becomes `active`.
- The step's next attempt re-resolves every value it needs from the live mappings and lookups, and fetches the KFA details of its codes from KFA v2 again, so a fixed mapping or a corrected KFA product takes effect at once.
- The replay is recorded in the case's `replays`.

`200` with the case as [`GET /v1/cases/{id}`](#get-v1casesid) shows it. A case in any other status is [`409 CASE_NOT_DEAD_LETTERED`](#case_not_dead_lettered); of two concurrent replays of one case, one replays it and the other gets that `409`. An unknown id is `404 NOT_FOUND`.

## `POST /v1/cases/{id}/abandon`

Admin API key only. Ends a case that can never complete, for good (ADR 0007). The body is required: `{ "note": "the visit was registered by mistake" }`; a missing or blank `note` (up to 2000 characters) is [`422 VALIDATION_FAILED`](#validation_failed).

- Only a `waiting` or `dead_lettered` case can be abandoned; any other status is [`409 CASE_NOT_ABANDONABLE`](#case_not_abandonable).
- In one transaction, every step not `completed` becomes `abandoned`, and the case `abandoned`. Nothing is sent to SATUSEHAT: records completed steps created there stay, and are listed in `abandonment.remoteRecordsLeft`.
- Afterwards, a duplicate ingest of an event the case accepted still gets its original `202`; any other event for the visit is [`409 CASE_ABANDONED`](#case_abandoned), and is logged in the rejection log.

`200` with the case as [`GET /v1/cases/{id}`](#get-v1casesid) shows it.

## `PUT /v1/admin/mappings/{drugs|locations}/{localCode}`

Admin API key only. Creates or replaces the operator's mapping of a source system's local code. The worker's seed files write the same tables. A mapping takes effect at a step's next attempt; a dead-lettered case needs a [replay](#post-v1casesidreplay).

| Kind | Body |
|---|---|
| `drugs` | `{ "source": "simulator", "kfaCode": "92000001", "note": "Parasetamol 500 mg Tablet" }`: `kfaCode` is digits |
| `locations` | `{ "source": "simulator", "locationId": "b017aa54-…", "note": null }` |

`source` must be a registered source system's id. `note` is optional, non-empty, up to 500 characters. A bad field is [`422 VALIDATION_FAILED`](#validation_failed); any other kind is `404 NOT_FOUND`.

`200` with the mapping as stored, for example `{ "source": "simulator", "localCode": "PCT500", "kfaCode": "92000001", "note": "Parasetamol 500 mg Tablet", "updatedAt": "2026-03-02T01:00:00.000Z" }`. `updatedAt` changes only when the mapping or its note does.

## `DELETE /v1/admin/mappings/{drugs|locations}/{localCode}?source={source}`

Admin API key only. Deletes the mapping: `204`, or `404 NOT_FOUND` when there is none. A step that needs it is dead-lettered `MAPPING_MISSING` at its next attempt; completed steps keep the values they pinned.

## Errors

Every error is an RFC 9457 problem, `Content-Type: application/problem+json`:

```json
{
  "type": "https://github.com/fudi-mahfudin/integration-hub/blob/main/docs/api.md#validation_failed",
  "title": "The request failed validation",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [
    { "path": "/data/startedAt", "code": "TIME_OFFSET_MISSING", "message": "must carry an explicit offset, e.g. 2026-03-02T08:00:00+07:00" }
  ]
}
```

`code` is stable; match on it, not on `title` or `message`. `errors[]` is always present and may be empty. Its `path` is a JSON Pointer into the request body.

### UNAUTHENTICATED

`401`. The API key is missing, malformed or unknown. The response carries `WWW-Authenticate: Bearer`.

### FORBIDDEN

`403`. A source system's API key called an operator endpoint, which only the admin API key may call.

### IDEMPOTENCY_KEY_MISSING

`400`. The `Idempotency-Key` header is missing.

### IDEMPOTENCY_KEY_INVALID

`400`. The `Idempotency-Key` header is empty or longer than 255 characters.

### IDEMPOTENCY_KEY_REUSED

`422`. This source system already used the key for a different body. Nothing was recorded.

### VALIDATION_FAILED

`422`. The event breaks its schema, or an operator request's body breaks its own (its `errors[]` use `REQUIRED` and `INVALID_FORMAT`). Every violation is listed in `errors[]`, each with one of these codes:

| `errors[].code` | Meaning |
|---|---|
| `REQUIRED` | A required field, or a required combination of fields, is missing. |
| `INVALID_FORMAT` | The value has the wrong type or format, or isn't one of the allowed values. A body that isn't JSON is reported at path `""`. |
| `TIME_OFFSET_MISSING` | A time has no explicit offset, or is only part of a date-time. |
| `DATE_BEFORE_FLOOR` | A time is before `2014-06-03T00:00:00+00:00` in UTC, or a `batch.expiry` is before `2014-06-03`. |
| `BATCH_INCOMPLETE` | A `batch` has a `lot` without an `expiry`, or an `expiry` without a `lot`. |
| `INVALID_SUBSTITUTION_REASON` | A `substitution.reasonCode` isn't one of the five allowed codes. |

### UNSUPPORTED_MULTI_ITEM

`422`. A `prescription.written` whose `items` doesn't hold exactly one item, or a second `prescription.written` for the visit with another `prescriptionId` or `itemId`. A case supports one prescription with one drug item (ADR 0004). Nothing is recorded: an event rejected this way opens no case, and the same key may be sent again with a corrected body.

### PRESCRIPTION_MISMATCH

`422`. A `drug.dispensed` names another `prescriptionId` or `itemId` than the visit's recorded `prescription.written`, or a `prescription.written` names another pair than the visit's recorded `drug.dispensed`. `errors[]` names each field that differs. Nothing is recorded, and the same key may be sent again with a corrected body.

### FINISHED_BEFORE_STARTED

`422`. A `visit.finished`'s `finishedAt` is not later than the visit's recorded `startedAt`, or a `visit.started`'s `startedAt` is not earlier than the visit's recorded `finishedAt` (rule 10121). `errors[]` names the field of the event just sent. Nothing is recorded, and the same key may be sent again with a corrected body.

### EVENT_ALREADY_RECORDED

`409`. The visit already has an event of this type under a different idempotency key, or under a key that has since been purged.

### CASE_ABANDONED

`409`. An operator abandoned the visit's case (ADR 0007); it takes no more events. A duplicate ingest of an event it accepted still gets its original answer. Nothing is recorded, apart from the rejection log.

### CASE_NOT_DEAD_LETTERED

`409`. Only a `dead_lettered` case can be replayed.

### CASE_NOT_ABANDONABLE

`409`. Only a `waiting` or `dead_lettered` case can be abandoned.

### NOT_FOUND

`404`. No such resource for this source system.

### INTERNAL_ERROR

`500`. An unexpected error. Retry with the same key: if the event was accepted after all, the retry gets the original answer.
