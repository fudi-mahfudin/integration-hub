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
4. Event schema ([`422 VALIDATION_FAILED`](#validation_failed)).
5. Checks against events already recorded for the visit ([`409 EVENT_ALREADY_RECORDED`](#event_already_recorded)).
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
| `type` | The event type. Only `visit.started` is accepted so far. |
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

### Times

- Times are ISO 8601 date-times with an explicit offset, for example `2026-03-02T08:00:00+07:00` or `2026-03-02T01:00:00Z`. Seconds and fractions are optional. A time without an offset, or only part of one (for example just a date), is `TIME_OFFSET_MISSING`.
- The date floor is `2014-06-03T00:00:00+00:00`, compared on the UTC value. `2014-06-03T05:00:00+07:00` is before it (`DATE_BEFORE_FLOOR`). It applies to `startedAt`, not to `occurredAt`.

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
| `steps[].attempts` | How many times a worker has claimed the step. |
| `steps[].remote` | The record the step stored at SATUSEHAT, by its remote identifier and `meta.versionId`; `null` until the step completes. |
| `steps[].deadLetterReason` | Why the step was dead-lettered; `null` unless it was. |
| `steps[].pins` | The values the step sent, pinned when it completed; later steps read these, never the live mappings or lookups. Create visit pins `patientIhsNumber`, `practitionerIhsNumber` and `locationId`. `null` until the step completes. |
| `steps[].attemptLog` | Every attempt at the step, oldest first. Append-only. |
| `attemptLog[].outcome` | `completed`; `dead_lettered`; `discarded` (the attempt lost its lease before it could store its outcome, which was thrown away); `failed` (it ended without an outcome, and the step stays in flight until its lease expires). |
| `attemptLog[].errorCode` | The dead-letter reason the attempt reached; otherwise `null`. |
| `attemptLog[].httpStatus` | The status of the last SATUSEHAT response the attempt read; `null` if it sent nothing. |
| `attemptLog[].valuesUsed`, `lookupMethods` | What the attempt had resolved, as far as it got, and how each person was found (`nik`). |
| `attemptLog[].violations` | Every violation step-time validation found, in rule order, each with `code`, `path` (a FHIR path, or `null`) and `message`. The dead-letter reason is the first one. |

### Dead-letter reasons

Just before a step sends anything, step-time validation checks what it built. Any violation dead-letters the step and sends nothing. The case becomes `dead_lettered` and its later steps are held. The validation codes, in rule order:

| Code | Meaning |
|---|---|
| `MAPPING_MISSING` | A local code the step needs has no mapping for this source system (for create visit, the visit's `locationCode`). Nothing was sent. |
| `KFA_LEVEL_INVALID` | The mapped KFA product has the wrong level: a prescription needs a 92 or 93, a dispense a 93. |
| `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION` | The dispensed product's active ingredients (its set of KFA 91 codes) differ from the prescribed product's. |
| `SUBSTITUTION_MISMATCH` | Whether the dispense is a substitution, as judged from KFA, disagrees with the source's `substitution` declaration. |
| `PAYLOAD_INVALID` | The built payload breaks a mandatory-field, time-format, date-floor or identifier-system rule: a hub bug. The details are in the attempt log. |

The codes for the KFA rules apply once the prescription and dispense steps are built. Lookups and search-then-create can also dead-letter a step:

| Code | Meaning |
|---|---|
| `PATIENT_NOT_FOUND` | SATUSEHAT has no single patient for the visit's `patient.nik`. Lookups other than by NIK are not yet made. |
| `PRACTITIONER_NOT_FOUND` | SATUSEHAT has no single practitioner for the visit's `practitioner.nik`. |
| `REMOTE_RECORD_AMBIGUOUS` | More than one record at SATUSEHAT already carries the step's identifier (for create visit, `encounter/{org}` with the `visitId`), so the hub can't tell which one is the visit's. |

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
| `DATE_BEFORE_FLOOR` | A time is before `2014-06-03T00:00:00+00:00` in UTC. |

### EVENT_ALREADY_RECORDED

`409`. The visit already has an event of this type under a different idempotency key, or under a key that has since been purged.

### NOT_FOUND

`404`. No such resource for this source system.

### INTERNAL_ERROR

`500`. An unexpected error. Retry with the same key: if the event was accepted after all, the retry gets the original answer.
