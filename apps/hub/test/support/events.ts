import { randomUUID } from 'node:crypto';

/** API keys of the two source systems `TEST_SOURCES` registers. */
export const SOURCE_API_KEY = 'test-source-key';
export const OTHER_SOURCE_API_KEY = 'other-source-key';

/** Two registered source systems, as `HUB_SOURCES` JSON. Pass to `bootHub`. */
export const TEST_SOURCES = JSON.stringify([
  { id: 'test-source', organizationId: '10000000-0000-4000-8000-000000000001', apiKey: SOURCE_API_KEY },
  { id: 'other-source', organizationId: '10000000-0000-4000-8000-000000000002', apiKey: OTHER_SOURCE_API_KEY },
]);

/** A fresh visit id, so suites sharing the one test database never collide. */
export function newVisitId(): string {
  return `V-${randomUUID()}`;
}

/** A valid `visit.started` envelope; `data` overrides are shallow-merged. */
export function visitStarted(overrides: { visitId?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: 'visit.started',
    visitId: overrides.visitId ?? newVisitId(),
    occurredAt: '2026-03-02T08:00:00+07:00',
    data: {
      patient: { nik: '9271060312000001', mrn: 'MRN-0001' },
      practitioner: { nik: '7209061211900001' },
      encounterClass: 'AMB',
      locationCode: 'POLI-UMUM',
      startedAt: '2026-03-02T08:00:00+07:00',
      ...overrides.data,
    },
  };
}

export interface PostOptions {
  /** `null` omits the header. Defaults to the test source's key. */
  apiKey?: string | null;
  /** `null` omits the header. Defaults to a fresh UUID. */
  idempotencyKey?: string | null;
  /** Sent as-is when a string, JSON-encoded otherwise. Defaults to a fresh `visitStarted()`. */
  body?: unknown;
}

/** `POST /v1/events` as a source system sends it. */
export function postEvent(baseUrl: string, options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = options.apiKey === undefined ? SOURCE_API_KEY : options.apiKey;
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  const key = options.idempotencyKey === undefined ? randomUUID() : options.idempotencyKey;
  if (key !== null) headers['idempotency-key'] = key;
  const body = options.body ?? visitStarted();
  return fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** `GET` a case by the `Location` a `202` returned, with a source key (default: the test source). */
export function getCase(baseUrl: string, location: string, apiKey = SOURCE_API_KEY): Promise<Response> {
  return fetch(new URL(location, baseUrl), { headers: { authorization: `Bearer ${apiKey}` } });
}
