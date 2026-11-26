# Mock SATUSEHAT

A stateful fake of the SATUSEHAT platform for tests, the big run and local runs. **Never deploy it publicly:** `/__mock/*` has no auth by design.

It validates submissions with its own code and shares none with the hub (ADR 0006); an import-boundary rule (`pnpm boundaries`, run in CI) forbids it from importing any hub module. It is documented as **stricter than the sandbox**: any rejection in a normal test run is a finding. All state is in memory.

```sh
pnpm --filter @integration-hub/mock-satusehat build
node packages/mock-satusehat/dist/main.js     # serves http://localhost:3001
```

## Settings (environment)

| Variable | Default | What |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3001` | Where it listens |
| `MOCK_WORLD_PATH` | `world/world.json` | The world dataset loaded at boot and on reset |
| `MOCK_TOKEN_EXPIRES_IN_SECONDS` | `3599` | `expires_in` of issued tokens (sent as a string) |
| `MOCK_TOKEN_THROTTLE_WINDOW_SECONDS` | `60` | After a failed token request, token requests within this window get `429` |

Extra seed data, fault rules and holds are set only through the API.

## SATUSEHAT-facing paths

The client credentials are the world's organization (`dev-satusehat-client` / `dev-satusehat-secret`, public dev values).

- `POST /oauth2/v1/accesstoken?grant_type=client_credentials` (form body `client_id`, `client_secret`)
- `GET /fhir-r4/v1/Patient?identifier=https://fhir.kemkes.go.id/id/nik|{nik}`, same for `Practitioner`
- `GET /fhir-r4/v1/Patient?identifier=https://fhir.kemkes.go.id/id/nik-ibu|{nik}`: every child of that mother, each with its `birthDate` (the docs give this search no birthdate parameter)
- `GET /fhir-r4/v1/Patient?name={name}&birthdate={YYYY-MM-DD}&gender={male|female}`, same for `Practitioner`, parameters in any order. The docs say only that a name is validated and may be partial or complete; the mock assumes a whole name, ignoring case and runs of spaces, until a live check observes it. The world's near-miss patients (`patientMarkers.nearMisses`) check that a near-miss never matches
- `GET /fhir-r4/v1/Location?_id={id}`
- `GET /fhir-r4/v1/Encounter?identifier=http://sys-ids.kemkes.go.id/encounter/{org}|{value}`
- `POST /fhir-r4/v1/Encounter`: validated, then stored with a new `id` and `meta.versionId`. A second create for the same identifier is stored too, so the duplicate shows in the report.
- `PUT /fhir-r4/v1/Encounter/{id}`: validated like a create, plus: `id` must be the one in the URL and the `encounter/{org}` identifier must stay the record's. Then replaces the record and answers `200` with `meta.versionId` bumped by one. Every applied PUT counts, even one that changes no field, so a second update of a visit shows in the report as a duplicate submission. An id the mock doesn't hold is `404`.
- `GET /fhir-r4/v1/MedicationRequest?identifier=http://sys-ids.kemkes.go.id/prescription/{org}|{value}`
- `POST /fhir-r4/v1/MedicationRequest`: validated by its own rules (mandatory fields, `+00:00` authoredOn and the floor, `prescription/{org}` and `prescription-item/{org}` identifiers, a contained Medication whose KFA code is a 92 or 93 in its catalogue, a quantity in that product's dose form), then stored like an Encounter. One that references an Encounter the mock doesn't hold is `400 REFERENCE_NOT_FOUND`. Logged under the visit key of the Encounter it references.
- `GET /fhir-r4/v1/MedicationDispense?identifier=http://sys-ids.kemkes.go.id/prescription/{org}|{value}` (a dispense reuses its prescription's identifiers)
- `POST /fhir-r4/v1/MedicationDispense`: validated by its own rules (mandatory fields, `+00:00` whenPrepared and whenHandedOver and the floor, a batch with a lot and a plain expiry date not before the floor, `prescription/{org}` and `prescription-item/{org}` identifiers, a quantity in the dispensed product's dose form), and judged against the MedicationRequest named by `authorizingPrescription`. The contained Medication must be an actual product (93) in its catalogue (`KFA_LEVEL_INVALID`). The prescribed product itself, or a 93 derived from the prescribed 92, must have `wasSubstituted: false`; another 93 with exactly the same ingredients must have `wasSubstituted: true` (`SUBSTITUTION_MISMATCH`); other ingredients are `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`. A substitution needs its type, reason and both responsible practitioners (requester and pharmacist). Then stored like an Encounter. An `authorizingPrescription` or `context` the mock doesn't hold is `400 REFERENCE_NOT_FOUND`. Logged under the visit key of the Encounter in `context`.
- `GET /kfa-v2/products?identifier=kfa&code={code}` (same token): a product (92 or 93) from the world's KFA catalogue with its `dosage_form`, `product_template` (the 92 of a 93) and `active_ingredients`, or an ingredient (91) with neither; an unknown code is `200 { "total": 0, "result": null }`.

Any other search parameter gets `400`: an unknown search reaching the mock is a hub bug. FHIR calls without a valid token get `401`. Validation failures are `400` OperationOutcomes with the rejection code (`PAYLOAD_INVALID`, `KFA_LEVEL_INVALID`, `UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`, `SUBSTITUTION_MISMATCH` or `REFERENCE_NOT_FOUND`) in `issue.details.coding`.

## Inspection and control API

Use it through the typed client, `@integration-hub/mock-satusehat/client`.

| Request | What |
|---|---|
| `GET /__mock/log?visitKey=&resourceType=&afterSeq=&limit=` | Submission log entries (`limit` 1-10000) |
| `GET /__mock/log.ndjson` | The whole log, one entry per line |
| `GET /__mock/report` | Duplicate submissions (more than one create per business identifier, or more than one applied update of one record), out-of-order effects and overlapping in-flight requests per visit, and the fault seed |
| `POST /__mock/reset` | Clears records, log, fault rules, tokens and throttle state; drops every parked or delayed request unanswered and unlogged; reloads the world |
| `POST /__mock/seed` | Adds world entries until the next reset |
| `POST /__mock/tokens/revoke` | Invalidates every issued token |
| `PUT /__mock/faults` | Replaces the fault rules (below) |
| `GET /__mock/holds?wait=ms` | Requests parked by `hold` rules, oldest first; when none is parked, waits up to `wait` ms (0-60000) for one |
| `POST /__mock/holds/{id}/release` | Lets a parked request go on to be applied and answered; `404` for an unknown id |
| `DELETE /__mock/records/{type}/{id}` | Deletes a stored Encounter, MedicationRequest or MedicationDispense: later searches miss it, a PUT gets `404`, a reference to it `REFERENCE_NOT_FOUND` |
| `PATCH /__mock/records/{type}/{id}` | JSON merge patch (RFC 7386), unvalidated, that may not touch `id` or `resourceType`; bumps `meta.versionId` |
| `POST /__mock/records` | Stores a record directly, unvalidated, under its own `id` (`409` if already stored) or a new one: a record the hub never created, or a second search match |

Record mutations are logged as `effect: "admin"` entries under the record's visit. They are a test's doing, not the hub's, so the report counts them nowhere. A refused mutation is not logged.

## Fault rules

`PUT /__mock/faults` takes `{ seed, rules: [{ id, match: { method?, resourceType?, path? }, kind, rate | everyNth | firstN, params }] }`. Rules are tried in order and the first that matches and hits a request decides its fault. `match.path` is compared with the path without its query string, so the token endpoint is matched like any other path (`/oauth2/v1/accesstoken`); `resourceType` is the one the log files the request under (`KfaProduct` for KFA v2).

Each request is counted per identifier: its method, resource type and business identifier, or its method, path and query when it has none (token, KFA, Location, person lookups). For the nth request of an identifier, a rule hits when `n <= firstN`, when `n` is a multiple of `everyNth`, or when a hash of (seed, rule id, identifier, n) falls below `rate` (0-1). The decision depends on nothing else. A record's requests come from one case, one step at a time, so the same seed gives each case the same faults however workers interleave. Requests without a business identifier are shared by cases: the nth request of a URL always meets the same fault, but which case sends the nth depends on arrival order. Setting rules restarts the counts.

| `kind` | `params` | What the request gets |
|---|---|---|
| `http_500` | | `500` OperationOutcome; not applied |
| `http_503`, `http_429` | `retryAfter?: { form: "seconds" \| "http-date", seconds }` | `503` / `429` OperationOutcome, with `Retry-After` as delta seconds or the HTTP date that many seconds from the mock's clock, or none; not applied |
| `http_400` | | `400` OperationOutcome with `PAYLOAD_INVALID`: a forced permanent rejection; not applied |
| `http_401` | | `401` as for a bad token; not applied |
| `timeout` | `ms` | Kept waiting `ms` (set it past the client's timeout), then the connection is dropped; not applied |
| `connection_reset` | | The connection is reset at once; not applied |
| `timeout_after_apply` | `ms` | Applied, then kept waiting `ms` and dropped: the effect counts though the client saw no answer |
| `http_500_after_apply` | | Applied, then answered `500`: the effect counts |
| `latency` | `ms`, or `minMs` and `maxMs` | Delayed by `ms`, or by a value drawn from the hash in `[minMs, maxMs]`, then applied and answered |
| `hold` | | Parked until released through `/__mock/holds`, then applied and answered |

A delayed or parked request whose client has gone is still applied when its wait ends, as a request that reached the platform would be, and a parked one stays listed until released.

A faulted request is logged with the rule's id in `fault`. One faulted before it was applied has `effect: "none"` and never counts in the report. One cut without an answer is logged with `response.status: null` when the connection goes. The report's `faultSeed` is the current rules' seed.

## World dataset and fixtures

`world/world.json` is generated by `pnpm --filter @integration-hub/mock-satusehat world:generate` (deterministic; sizes from `bigrun.commitments.json`). Every value is fake.

Response bodies come from typed builders in `src/templates/`. Each one is tagged `fhir-spec | satusehat-docs | sandbox-observed | assumed` with a one-line note (and only a link for docs), and a test fails if one lacks it. The `assumed` tags are the to-do list for the contract check.
