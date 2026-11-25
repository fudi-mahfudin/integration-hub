import { randomUUID } from 'node:crypto';

/** API keys of the two source systems `TEST_SOURCES` registers. */
export const SOURCE_API_KEY = 'test-source-key';
export const OTHER_SOURCE_API_KEY = 'other-source-key';

/** Two registered source systems, as `HUB_SOURCES` JSON. */
export const TEST_SOURCES = JSON.stringify([
  { id: 'test-source', organizationId: '10000001', apiKey: SOURCE_API_KEY },
  { id: 'other-source', organizationId: '10000002', apiKey: OTHER_SOURCE_API_KEY },
]);

/** A fresh visit id, so suites sharing the one test database never collide. */
export function newVisitId(): string {
  return `V-${randomUUID()}`;
}

/** A valid `visit.started` envelope with fake values; `data` overrides are shallow-merged. */
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

/** What `postEvent` sends; every field defaults to a valid request. */
export interface PostEventOptions {
  /** `null` sends no Idempotency-Key header; default is a fresh UUID. */
  idempotencyKey?: string | null;
  /** `null` sends no Authorization header; default is `SOURCE_API_KEY`. */
  apiKey?: string | null;
  /** A string is sent as is; anything else is JSON-encoded. Default: a fresh `visitStarted()`. */
  body?: unknown;
}

/** `POST /v1/events` as a source system would send it. */
export function postEvent(baseUrl: URL, options: PostEventOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = options.apiKey === undefined ? SOURCE_API_KEY : options.apiKey;
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  const key = options.idempotencyKey === undefined ? randomUUID() : options.idempotencyKey;
  if (key !== null) headers['idempotency-key'] = key;
  const body = options.body === undefined ? visitStarted() : options.body;
  return fetch(new URL('v1/events', baseUrl), {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** `GET /v1/cases/{id}` with a source system's key. */
export function getCase(baseUrl: URL, caseId: string, apiKey: string = SOURCE_API_KEY): Promise<Response> {
  return fetch(new URL(`v1/cases/${encodeURIComponent(caseId)}`, baseUrl), {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}
