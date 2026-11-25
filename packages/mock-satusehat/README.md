# Mock SATUSEHAT

A stateful, in-memory stand-in for the SATUSEHAT platform, used by the test suite, the big run and k6. **It has no authentication on `/__mock/*` and must never be deployed publicly**: it runs only in Vitest and in local/CI compose.

- Platform surface: `POST /oauth2/v1/accesstoken?grant_type=client_credentials`, FHIR under `/fhir-r4/v1`.
- Inspection and control: `/__mock/*`, used only through `MockClient` (`@integration-hub/mock-satusehat`).
- Validation is the mock's own code (ADR 0006), stricter than the sandbox. It shares no code with the hub; `pnpm lint:boundaries` enforces that.
- Fixtures are typed builders in `src/templates/`, each tagged with its provenance (#16). Every value is fake.
- World dataset: `world/world.json`, regenerated with `pnpm world:generate` (sizes from `bigrun.commitments.json`).

Run standalone: `pnpm --filter @integration-hub/mock-satusehat start` (env: `MOCK_PORT` 4010, `MOCK_HOST`, `MOCK_WORLD_PATH`, `MOCK_TOKEN_EXPIRES_IN` 3599, `MOCK_TOKEN_THROTTLE_WINDOW_MS` 60000).
