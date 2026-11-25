# Hub API contract

The HTTP API source systems (and, later, the dashboard) use. Terms are defined in [GLOSSARY.md](../GLOSSARY.md). This file grows as endpoints land.

## Authentication

Every request carries `Authorization: Bearer <api key>`. Each source system has one static key, and the hub derives the source system and its SATUSEHAT organization from it; the body never names its source. A missing, malformed or unknown key is `401 UNAUTHENTICATED`.

## Errors

Every error is an RFC 9457 problem, `Content-Type: application/problem+json`:

```json
{
  "type": "https://github.com/fudi-mahfudin/integration-hub/blob/main/docs/api.md#validation-failed",
  "title": "The event failed validation",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [{ "path": "/data/startedAt", "code": "TIME_OFFSET_MISSING", "message": "must be a full date-time with an offset, e.g. +07:00" }]
}
```

`code` is stable; branch on it, not on `title` or `message`. `errors[]` is always present (empty when there are no field errors); `path` is a JSON Pointer into the request body (`""` is the whole body).

## `POST /v1/events`

Submits one source event. The hub accepts it and answers without waiting for SATUSEHAT.

Headers: `Authorization`, `Idempotency-Key` (required, opaque, 1 to 255 characters, a UUID is fine but not required).

Body, the envelope: `{ type, visitId, occurredAt, data }`. `visitId` is the source system's own visit number, unique per source system. Event types: `visit.started`, `prescription.written`, `drug.dispensed`, `visit.finished`. Events of one visit may arrive in any order: an event whose predecessor is missing is stored and its step waits as `blocked`.

`visit.started` `data`:

| Field | Rule |
|---|---|
| `patient` | `{ mrn, nik?, motherNik?, name?, birthDate?, gender? }` with `mrn` and one of: `nik` · `motherNik` + `birthDate` · `name` + `birthDate` + `gender` |
| `practitioner` | `{ nik }` or `{ name, birthDate, gender }` |
| `encounterClass` | `AMB`, `IMP` or `EMER` |
| `locationCode` | the source system's local location code |
| `startedAt` | date-time with offset, not before the floor |

`prescription.written` `data`:

| Field | Rule |
|---|---|
| `prescriptionId` | the source's prescription number (the `prescription/{org}` identifier) |
| `authoredAt` | date-time with offset, not before the floor |
| `requester` | `{ nik }` or `{ name, birthDate, gender }` |
| `items` | exactly one `{ itemId, drugCode, quantity, dosage { text, timesPerDay, doseAmount, routeCode } }`; any other count is `422 UNSUPPORTED_MULTI_ITEM` (checked after the schema) |

`drugCode` is the source's local drug code (the hub maps it to KFA); `quantity` and `doseAmount` are positive numbers, `timesPerDay` a positive integer; the unit is never sent (the hub takes it from the KFA product's dose form). `itemId` is the `prescription-item/{org}` identifier.

`drug.dispensed` `data`:

| Field | Rule |
|---|---|
| `prescriptionId`, `itemId` | the prescription and item it fills; must be the visit's (`422 PRESCRIPTION_MISMATCH`, checked when the second of the prescription and the dispense arrives) |
| `drugCode` | the local code of the product actually handed over (the hub maps it to a KFA 93) |
| `quantity` | positive number, in the product's dose form |
| `preparedAt`, `handedOverAt` | date-times with offset, not before the floor |
| `pharmacist` | `{ nik }` or `{ name, birthDate, gender }` |
| `batch` | optional `{ lot, expiry }`, both or neither (`BATCH_INCOMPLETE`); `expiry` is a plain `YYYY-MM-DD` date, sent as is, not before `2014-06-03` |
| `substitution` | optional `{ reasonCode }`, one of `OS`, `FP`, `DRUG_INTERACTION`, `PATIENT_CHOICE`, `PRESCRIPTION_ERROR` (else `INVALID_SUBSTITUTION_REASON`). Declare it exactly when the product is neither the prescribed 93 nor a child of the prescribed 92; the hub decides from KFA and dead-letters a disagreement (`SUBSTITUTION_MISMATCH`) |

`visit.finished` `data`:

| Field | Rule |
|---|---|
| `finishedAt` | date-time with offset, not before the floor; must be after the visit's `startedAt` (`422 FINISHED_BEFORE_STARTED`, checked when the second of `visit.started` and `visit.finished` arrives, on whole seconds since times are sent truncated) |

NIKs are 16 digits; `birthDate` is `YYYY-MM-DD`; `gender` is `male` or `female`.

**Times** (`occurredAt`, `startedAt`) must be ISO 8601 date-times with an explicit offset (`Z` allowed), e.g. `2026-03-02T08:00:00+07:00`. A time without an offset, or a partial one, is `TIME_OFFSET_MISSING`. `startedAt` must not be before `2014-06-03T00:00:00+00:00`, compared on the UTC instant (so `2014-06-03T05:00+07:00` is `DATE_BEFORE_FLOOR`).

### Answers, in check order

1. `401 UNAUTHENTICATED`: no or unknown API key.
2. `400 IDEMPOTENCY_KEY_MISSING` / `400 IDEMPOTENCY_KEY_INVALID`: the header is missing, empty or longer than 255 characters.
3. Key lookup. If this source system has already had an event accepted under this key:
   - same body: the original answer, status and body byte for byte, plus `Idempotent-Replayed: true` (a **duplicate ingest**). `caseStatus` in it is the status at first acceptance, not now.
   - different body: `422 IDEMPOTENCY_KEY_REUSED`. Bodies are compared by the SHA-256 of their RFC 8785 canonical form, so key order and whitespace do not matter.
4. `422 VALIDATION_FAILED`: the event's own schema. Every violation is listed at once in `errors[]` with a field code: `REQUIRED`, `INVALID_FORMAT`, `TIME_OFFSET_MISSING`, `DATE_BEFORE_FLOOR`, `BATCH_INCOMPLETE`, `INVALID_SUBSTITUTION_REASON`.
5. `422 UNSUPPORTED_MULTI_ITEM`: a prescription without exactly one item, or a second `prescription.written` for the visit naming another `prescriptionId`/`itemId` (one item per visit, ADR 0004).
6. `409 EVENT_ALREADY_RECORDED`: the visit already has an event of this type, sent under another key (or under a key no longer retained, below).
7. `422 PRESCRIPTION_MISMATCH`: the prescription and the dispense of the visit name different `prescriptionId`/`itemId`; the one arriving second is rejected, `errors[]` names the field(s).
8. `422 FINISHED_BEFORE_STARTED`: the visit's `finishedAt` is not after its `startedAt`; the one arriving second is rejected, `errors[]` names its field.
9. `202 Accepted`, body `{ visitId, type, caseStatus }`, header `Location: /v1/cases/{id}`.

Only a `202` consumes the key: after any `4xx`/`5xx` nothing is recorded against it, and the same key may be sent again with a corrected body. Rejections from step 4 on are written to the visit's **rejection log** (code, event type, time; never the body), shown on the case as `rejections` and never changing its state. Concurrent identical requests get identical answers and open one case.

### Idempotency key retention

**An accepted key is kept for at least 24 hours** (`IDEMPOTENCY_RETENTION_HOURS`, never below 24), then deleted by an hourly purge. Until it is purged a duplicate ingest gets the stored answer. After that, an identical resend of an event that was recorded gets `409 EVENT_ALREADY_RECORDED` instead of the stored answer: the event is still recorded exactly once, only the answer differs. Resend within 24 hours to be sure of the stored answer.

## `GET /v1/cases/{id}`

The case and its step states. A source system's key sees only its own cases; any other id is `404 NOT_FOUND`.

```json
{
  "caseId": "…",
  "source": "simulator",
  "visitId": "V-1",
  "status": "active",
  "waitingFor": null,
  "waitingSince": null,
  "rejections": [{ "code": "UNSUPPORTED_MULTI_ITEM", "eventType": "prescription.written", "rejectedAt": "…" }],
  "steps": [
    {
      "step": "create_visit", "eventType": "visit.started", "state": "completed", "attempts": 1, "deadLetterReason": null,
      "remote": { "type": "Encounter", "id": "…", "version": "…" },
      "pins": { "patientIhs": "…", "practitionerIhs": "…", "locationId": "…" },
      "attemptLog": [
        {
          "attempt": 1, "startedAt": "…", "endedAt": "…", "outcome": "completed", "errorCode": null, "httpStatus": 201,
          "used": { "location": { "localCode": "POLI-PD", "locationId": "…" }, "patient": { "ihsNumber": "…", "method": "nik" }, "practitioner": { "ihsNumber": "…", "method": "nik" } },
          "violations": [], "detail": null
        }
      ]
    },
    { "step": "submit_prescription", "eventType": "prescription.written", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "remote": null, "pins": null, "attemptLog": [] },
    { "step": "submit_dispense", "eventType": "drug.dispensed", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "remote": null, "pins": null, "attemptLog": [] },
    { "step": "update_visit", "eventType": "visit.finished", "state": "awaiting_event", "attempts": 0, "deadLetterReason": null, "remote": null, "pins": null, "attemptLog": [] }
  ]
}
```

Per step: `attempts` counts claims by a worker (an attempt is counted when it starts); `remote` is the SATUSEHAT record the step created or adopted (its remote identifier), set only when the step completes; `deadLetterReason` is a stable code when the step is `dead_lettered`. Reasons so far: `MAPPING_MISSING` (no location mapping for the event's `locationCode`, no drug mapping for its `drugCode`, or a mapped KFA code that KFA does not know), `KFA_LEVEL_INVALID` (the drug maps to a KFA level the step cannot use: a prescription 92 or 93, a dispense only 93), `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION` (the dispensed 93 is neither the prescribed 93 nor a child of the prescribed 92 and has other active ingredients (91 set)), `SUBSTITUTION_MISMATCH` (the hub's substitution decision from KFA disagrees with the source's `substitution` declaration, in either direction; these two are bad source data that replay cannot fix), `PAYLOAD_INVALID` (the payload the hub built broke a payload rule: mandatory field, time format, date floor, identifier system or reference; a hub bug or a malformed mapping value; the rule and path are in the attempt log. Also when SATUSEHAT itself rejects a call with a 4xx OperationOutcome other than 401, 403, 404, 408, 410 and 429: the hub's own rules let through something the platform refuses, and its status is in the attempt log), `PLATFORM_FORBIDDEN` (SATUSEHAT answered 403 with an OperationOutcome: credentials or configuration), `PATIENT_NOT_FOUND`, `PRACTITIONER_NOT_FOUND` (no single IHS number for the NIK), `REMOTE_RECORD_AMBIGUOUS` (the search by the step's local identifier found more than one record, so the hub will not guess).

Before sending, every payload is checked by the hub's Validation module; a violation dead-letters the step and holds the rest of the case. When there are several, `deadLetterReason` is the first in rule order (`MAPPING_MISSING`, `KFA_LEVEL_INVALID`, `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`, `SUBSTITUTION_MISMATCH`, `PAYLOAD_INVALID`) and all of them are in the attempt's `violations`.

`pins` are the values a completed step sent (create visit: `patientIhs`, `practitionerIhs`, `locationId`; submit prescription: `kfaCode`, `kfaLevel`, `parent92`, `ingredients` (the 91 set), `requesterIhs`; submit dispense: the dispensed `kfaCode`, `kfaLevel`, `parent92`, `ingredients`, `pharmacistIhs`, `wasSubstituted`; update visit: `finishedAt`, the `period.end` sent), stored with its remote identifier; later steps use these, never the live mappings. `attemptLog` is append-only, one entry per finished attempt: `outcome` (`completed`, `dead_lettered`, `retry_wait`, or `lease_expired`: the worker lost its lease, e.g. crashed; written when another worker reclaims the step, `endedAt` = the lease expiry, no status or `used`), `errorCode`, the last platform `httpStatus`, the values `used` with the patient/practitioner lookup `method` (and for a prescription `drug { localCode, kfaCode, kfa }` and `requester`, for a dispense `drug` and `pharmacist`, for a visit update the `encounter` id), every validation violation (`code`, `path`, `message`, `rule`, and `mapping` for a missing mapping) and a `detail` message for transient failures and platform rejections. A 5xx, timeout, network error, 401 (after one token refresh), 404, 408, 410 or 429 is transient: the step goes to `retry_wait` and is tried again.

`status` is `waiting` (with `waitingFor`, the earliest missing event type, and `waitingSince`), `active`, `dead_lettered`, `completed` or `abandoned`. Step states: `awaiting_event`, `blocked`, `ready`, `in_flight`, `retry_wait`, `completed`, `dead_lettered`.

## Problem codes

| `code` | Status | Meaning |
|---|---|---|
| <a id="unauthenticated"></a>`UNAUTHENTICATED` | 401 | Missing or unknown API key |
| <a id="idempotency-key-missing"></a>`IDEMPOTENCY_KEY_MISSING` | 400 | No `Idempotency-Key` header |
| <a id="idempotency-key-invalid"></a>`IDEMPOTENCY_KEY_INVALID` | 400 | Empty or longer than 255 characters |
| <a id="idempotency-key-reused"></a>`IDEMPOTENCY_KEY_REUSED` | 422 | Key already accepted with a different body |
| <a id="validation-failed"></a>`VALIDATION_FAILED` | 422 | The event's own schema; see `errors[]` |
| <a id="unsupported-multi-item"></a>`UNSUPPORTED_MULTI_ITEM` | 422 | A prescription must have exactly one item, and a visit one prescription item |
| <a id="event-already-recorded"></a>`EVENT_ALREADY_RECORDED` | 409 | The visit already has this event type |
| <a id="prescription-mismatch"></a>`PRESCRIPTION_MISMATCH` | 422 | The dispense and the visit's prescription name different `prescriptionId`/`itemId` |
| <a id="finished-before-started"></a>`FINISHED_BEFORE_STARTED` | 422 | `finishedAt` is not after the visit's `startedAt` |
| <a id="not-found"></a>`NOT_FOUND` | 404 | No such resource for this caller |
| <a id="internal-error"></a>`INTERNAL_ERROR` | 500 | Unexpected server error |
