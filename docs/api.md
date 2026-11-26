# Hub API contract

The HTTP API the hub service offers to source systems. Domain terms are in [GLOSSARY.md](../GLOSSARY.md). This file grows as tickets land; it describes only what the hub does today.

## Authentication

Every request carries `Authorization: Bearer <api key>`. Each source system has one static API key. The source system's identity, and the SATUSEHAT organization it belongs to, come from the key, never from the request body. A missing, malformed or unknown key is [`401 UNAUTHENTICATED`](#unauthenticated).

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
5. Checks against events already recorded for the visit ([`409 EVENT_ALREADY_RECORDED`](#event_already_recorded), [`422 UNSUPPORTED_MULTI_ITEM`](#unsupported_multi_item) for a second prescription item, [`422 PRESCRIPTION_MISMATCH`](#prescription_mismatch) when a prescription and its dispense name different items, or [`422 FINISHED_BEFORE_STARTED`](#finished_before_started) when a visit's `finishedAt` is not later than its `startedAt`).
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

A visit's two events may arrive in either order. Whichever arrives second is checked against the first: `finishedAt` must be later than `startedAt`, compared as instants, or it is [`422 FINISHED_BEFORE_STARTED`](#finished_before_started). A second `visit.finished` for the visit is `409 EVENT_ALREADY_RECORDED`. The visit's Encounter is updated once the dispense has been submitted, and the case is then `completed`.

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

A case's status, what a waiting case waits for, and its four steps in order. A source system sees only its own cases; any other id is [`404 NOT_FOUND`](#not_found).

```json
{
  "caseId": "0b6f6c1e-8a0e-4d55-9b4b-3f1f1d7f2a10",
  "visitId": "V-2026-000123",
  "status": "waiting",
  "waitingFor": "prescription.written",
  "waitingSince": "2026-03-02T01:00:03.120Z",
  "rejections": [
    { "code": "UNSUPPORTED_MULTI_ITEM", "eventType": "prescription.written", "rejectedAt": "2026-03-02T01:05:41.002Z" }
  ],
  "steps": [
    {
      "step": "create_visit", "eventType": "visit.started", "state": "completed", "attempts": 1, "deadLetterReason": null,
      "remote": { "type": "Encounter", "id": "5f8d2c8e-7a51-4b0e-9a57-0d7c3f1e9b42", "version": "1" },
      "pins": { "patientIhsNumber": "P00000000001", "practitionerIhsNumber": "10000000001", "locationId": "b017aa54-f1df-4ec2-9d84-8823815d7228" },
      "attemptLog": [
        {
          "attempt": 1, "startedAt": "2026-03-02T01:00:03.140Z", "endedAt": "2026-03-02T01:00:03.410Z",
          "outcome": "completed", "errorCode": null, "httpStatus": 201,
          "valuesUsed": { "locationId": "b017aa54-f1df-4ec2-9d84-8823815d7228", "patientIhsNumber": "P00000000001", "practitionerIhsNumber": "10000000001" },
          "lookupMethods": { "patient": "nik", "practitioner": "nik" },
          "violations": []
        }
      ]
    },
    { "step": "submit_prescription", "eventType": "prescription.written", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "remote": null, "pins": null, "attemptLog": [] },
    { "step": "submit_dispense", "eventType": "drug.dispensed", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "remote": null, "pins": null, "attemptLog": [] },
    { "step": "update_visit", "eventType": "visit.finished", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "remote": null, "pins": null, "attemptLog": [] }
  ]
}
```

Case status: `waiting`, `active`, `dead_lettered`, `completed`, `abandoned`. Step state: `awaiting_event`, `blocked`, `ready`, `in_flight`, `retry_wait`, `completed`, `dead_lettered`.

| Field | Meaning |
|---|---|
| `waitingFor` | For a `waiting` case, the source event its next step needs; otherwise `null`. |
| `waitingSince` | Since when a `waiting` case has waited for `waitingFor` (UTC); otherwise `null`. |
| `rejections` | The rejection log of the visit: every `VALIDATION_FAILED`, `UNSUPPORTED_MULTI_ITEM`, `PRESCRIPTION_MISMATCH`, `FINISHED_BEFORE_STARTED` and `EVENT_ALREADY_RECORDED` answer to an event naming this `visitId` and an event type, oldest first, including those sent before the case opened. Only the code, the event type and the time are kept, never the body. It explains a waiting case and never changes it. |
| `steps[].attempts` | How many times a worker has claimed the step. |
| `steps[].remote` | The record the step stored at SATUSEHAT, by its remote identifier and `meta.versionId`; `null` until the step completes. |
| `steps[].deadLetterReason` | Why the step was dead-lettered; `null` unless it was. |
| `steps[].pins` | The values the step sent, pinned when it completed; later steps read these, never the live mappings or lookups. Create visit pins `patientIhsNumber`, `practitionerIhsNumber` and `locationId`. Submit prescription pins the prescribed KFA product (`kfaCode`, `kfaLevel`, `parent92`, `activeIngredients`, its 91 codes) and `requesterIhsNumber`. Submit dispense pins the dispensed KFA product (the same four fields) and `pharmacistIhsNumber`. Update visit pins the create visit values it sent again. `null` until the step completes. |
| `steps[].attemptLog` | Every attempt at the step, oldest first. Append-only. |
| `attemptLog[].outcome` | `completed`; `dead_lettered`; `discarded` (the attempt lost its lease before it could store its outcome, which was thrown away); `failed` (it ended without an outcome, and the step stays in flight until its lease expires). |
| `attemptLog[].errorCode` | The dead-letter reason the attempt reached; otherwise `null`. |
| `attemptLog[].httpStatus` | The status of the last SATUSEHAT response the attempt read; `null` if it sent nothing. |
| `attemptLog[].valuesUsed`, `lookupMethods` | What the attempt had resolved, as far as it got (the values its step pins), and how each person was found (`nik`). |
| `attemptLog[].httpStatus` for KFA | A KFA v2 lookup that answers a 5xx or takes longer than `SATUSEHAT_KFA_TIMEOUT_MS` ends the attempt as `failed`: transient, never a dead letter. |
| `attemptLog[].violations` | Every violation step-time validation found, in rule order, each with `code`, `path` (a FHIR path, or `null`) and `message`. The dead-letter reason is the first one. |

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
| `PATIENT_NOT_FOUND` | SATUSEHAT has no single patient for the visit's `patient.nik`. Lookups other than by NIK are not yet made. |
| `PRACTITIONER_NOT_FOUND` | SATUSEHAT has no single practitioner for the visit's `practitioner.nik`, the prescription's `requester.nik`, or the dispense's `pharmacist.nik`. |
| `REMOTE_RECORD_AMBIGUOUS` | More than one record at SATUSEHAT already carries the step's identifier (for create visit, `encounter/{org}` with the `visitId`; for submit prescription and submit dispense, `prescription/{org}` with the `prescriptionId`, which a MedicationDispense reuses), so the hub can't tell which one is the visit's. |

## Errors

Every error is an RFC 9457 problem, `Content-Type: application/problem+json`:

```json
{
  "type": "https://github.com/fudi-mahfudin/integration-hub/blob/main/docs/api.md#validation_failed",
  "title": "The source event failed validation",
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

### IDEMPOTENCY_KEY_MISSING

`400`. The `Idempotency-Key` header is missing.

### IDEMPOTENCY_KEY_INVALID

`400`. The `Idempotency-Key` header is empty or longer than 255 characters.

### IDEMPOTENCY_KEY_REUSED

`422`. This source system already used the key for a different body. Nothing was recorded.

### VALIDATION_FAILED

`422`. The event breaks its schema. Every violation is listed in `errors[]`, each with one of these codes:

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

### NOT_FOUND

`404`. No such resource for this source system.

### INTERNAL_ERROR

`500`. An unexpected error. Retry with the same key: if the event was accepted after all, the retry gets the original answer.
