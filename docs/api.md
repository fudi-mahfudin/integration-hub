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

Body, the envelope: `{ type, visitId, occurredAt, data }`. `visitId` is the source system's own visit number, unique per source system. Event types accepted so far: `visit.started`.

`visit.started` `data`:

| Field | Rule |
|---|---|
| `patient` | `{ mrn, nik?, motherNik?, name?, birthDate?, gender? }` with `mrn` and one of: `nik` · `motherNik` + `birthDate` · `name` + `birthDate` + `gender` |
| `practitioner` | `{ nik }` or `{ name, birthDate, gender }` |
| `encounterClass` | `AMB`, `IMP` or `EMER` |
| `locationCode` | the source system's local location code |
| `startedAt` | date-time with offset, not before the floor |

NIKs are 16 digits; `birthDate` is `YYYY-MM-DD`; `gender` is `male` or `female`.

**Times** (`occurredAt`, `startedAt`) must be ISO 8601 date-times with an explicit offset (`Z` allowed), e.g. `2026-03-02T08:00:00+07:00`. A time without an offset, or a partial one, is `TIME_OFFSET_MISSING`. `startedAt` must not be before `2014-06-03T00:00:00+00:00`, compared on the UTC instant (so `2014-06-03T05:00+07:00` is `DATE_BEFORE_FLOOR`).

### Answers, in check order

1. `401 UNAUTHENTICATED`: no or unknown API key.
2. `400 IDEMPOTENCY_KEY_MISSING` / `400 IDEMPOTENCY_KEY_INVALID`: the header is missing, empty or longer than 255 characters.
3. Key lookup. If this source system has already had an event accepted under this key:
   - same body: the original answer, status and body byte for byte, plus `Idempotent-Replayed: true` (a **duplicate ingest**). `caseStatus` in it is the status at first acceptance, not now.
   - different body: `422 IDEMPOTENCY_KEY_REUSED`. Bodies are compared by the SHA-256 of their RFC 8785 canonical form, so key order and whitespace do not matter.
4. `422 VALIDATION_FAILED`: the event's own schema. Every violation is listed at once in `errors[]` with a field code: `REQUIRED`, `INVALID_FORMAT`, `TIME_OFFSET_MISSING`, `DATE_BEFORE_FLOOR`.
5. `409 EVENT_ALREADY_RECORDED`: the visit already has an event of this type, sent under another key (or under a key no longer retained, below).
6. `202 Accepted`, body `{ visitId, type, caseStatus }`, header `Location: /v1/cases/{id}`.

Only a `202` consumes the key: after any `4xx`/`5xx` nothing is recorded, and the same key may be sent again with a corrected body. Concurrent identical requests get identical answers and open one case.

### Idempotency key retention

**An accepted key is kept for at least 24 hours** (`IDEMPOTENCY_RETENTION_HOURS`, never below 24), then deleted by an hourly purge. Until it is purged it keeps replaying. After that, an identical resend of an event that was recorded gets `409 EVENT_ALREADY_RECORDED` instead of the replay: the event is still recorded exactly once, only the answer differs. Resend within 24 hours to be sure of a replay.

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
  "steps": [
    { "step": "create_visit", "eventType": "visit.started", "state": "ready" },
    { "step": "submit_prescription", "eventType": "prescription.written", "state": "awaiting_event" },
    { "step": "submit_dispense", "eventType": "drug.dispensed", "state": "awaiting_event" },
    { "step": "update_visit", "eventType": "visit.finished", "state": "awaiting_event" }
  ]
}
```

`status` is `waiting` (with `waitingFor`, the earliest missing event type, and `waitingSince`), `active`, `dead_lettered`, `completed` or `abandoned`. Step states: `awaiting_event`, `blocked`, `ready`, `in_flight`, `retry_wait`, `completed`, `dead_lettered`.

## Problem codes

| `code` | Status | Meaning |
|---|---|---|
| <a id="unauthenticated"></a>`UNAUTHENTICATED` | 401 | Missing or unknown API key |
| <a id="idempotency-key-missing"></a>`IDEMPOTENCY_KEY_MISSING` | 400 | No `Idempotency-Key` header |
| <a id="idempotency-key-invalid"></a>`IDEMPOTENCY_KEY_INVALID` | 400 | Empty or longer than 255 characters |
| <a id="idempotency-key-reused"></a>`IDEMPOTENCY_KEY_REUSED` | 422 | Key already accepted with a different body |
| <a id="validation-failed"></a>`VALIDATION_FAILED` | 422 | The event's own schema; see `errors[]` |
| <a id="event-already-recorded"></a>`EVENT_ALREADY_RECORDED` | 409 | The visit already has this event type |
| <a id="not-found"></a>`NOT_FOUND` | 404 | No such resource for this caller |
| <a id="internal-error"></a>`INTERNAL_ERROR` | 500 | Unexpected server error |
