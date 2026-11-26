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

Extra seed data is set only through the API, as fault rules and holds will be (#33). The log's `fault` field and the report's `faultSeed` stay `null` until then.

## SATUSEHAT-facing paths

The client credentials are the world's organization (`dev-satusehat-client` / `dev-satusehat-secret`, public dev values).

- `POST /oauth2/v1/accesstoken?grant_type=client_credentials` (form body `client_id`, `client_secret`)
- `GET /fhir-r4/v1/Patient?identifier=https://fhir.kemkes.go.id/id/nik|{nik}`, same for `Practitioner`
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
| `POST /__mock/reset` | Clears records, log, tokens and throttle state; reloads the world |
| `POST /__mock/seed` | Adds world entries until the next reset |
| `POST /__mock/tokens/revoke` | Invalidates every issued token |

## World dataset and fixtures

`world/world.json` is generated by `pnpm --filter @integration-hub/mock-satusehat world:generate` (deterministic; sizes from `bigrun.commitments.json`). Every value is fake.

Response bodies come from typed builders in `src/templates/`. Each one is tagged `fhir-spec | satusehat-docs | sandbox-observed | assumed` with a one-line note (and only a link for docs), and a test fails if one lacks it. The `assumed` tags are the to-do list for the contract check.
