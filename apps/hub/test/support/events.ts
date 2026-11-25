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

/** One valid `prescription.written` item; overrides are shallow-merged. */
export function prescriptionItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'RX-1-1',
    drugCode: 'PCT-500',
    quantity: 10,
    dosage: { text: '3 x 1 tablet sesudah makan', timesPerDay: 3, doseAmount: 1, routeCode: 'O' },
    ...overrides,
  };
}

/** A valid single-item `prescription.written` envelope; `data` overrides are shallow-merged. */
export function prescriptionWritten(overrides: { visitId?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: 'prescription.written',
    visitId: overrides.visitId ?? newVisitId(),
    occurredAt: '2026-03-02T08:30:00+07:00',
    data: {
      prescriptionId: 'RX-1',
      authoredAt: '2026-03-02T08:30:00+07:00',
      requester: { nik: '7209061211900001' },
      items: [prescriptionItem()],
      ...overrides.data,
    },
  };
}

/** A valid `drug.dispensed` envelope for the item `prescriptionWritten()` prescribes; `data` overrides are shallow-merged. */
export function drugDispensed(overrides: { visitId?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: 'drug.dispensed',
    visitId: overrides.visitId ?? newVisitId(),
    occurredAt: '2026-03-02T09:10:00+07:00',
    data: {
      prescriptionId: 'RX-1',
      itemId: 'RX-1-1',
      drugCode: 'PCT-500',
      quantity: 10,
      preparedAt: '2026-03-02T09:00:00+07:00',
      handedOverAt: '2026-03-02T09:10:00+07:00',
      pharmacist: { nik: '7209061211900002' },
      batch: { lot: 'LOT-1', expiry: '2028-01-31' },
      ...overrides.data,
    } as Record<string, unknown>,
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

/** One row of a step's append-only attempt log in the case view. */
export interface AttemptLogEntry {
  attempt: number;
  startedAt: string;
  endedAt: string;
  outcome: 'completed' | 'dead_lettered' | 'retry_wait';
  errorCode: string | null;
  httpStatus: number | null;
  used: Record<string, unknown>;
  violations: { code: string; path: string; message: string; rule?: string; mapping?: { kind: string; localCode: string } }[];
  detail: string | null;
}

/** The shape of `GET /v1/cases/{id}`. */
export interface CaseView {
  caseId: string;
  source: string;
  visitId: string;
  status: string;
  waitingFor: string | null;
  waitingSince: string | null;
  /** Ingest rejections for this (source, visitId), oldest first (#8). */
  rejections: { code: string; eventType: string | null; rejectedAt: string }[];
  steps: {
    step: string;
    eventType: string;
    state: string;
    attempts: number;
    deadLetterReason: string | null;
    remote: { type: string; id: string; version: string | null } | null;
    pins: Record<string, unknown> | null;
    attemptLog: AttemptLogEntry[];
  }[];
}

/**
 * Reads the case at `location` until `done` holds (polling, no fake timers)
 * and returns that view; fails with the last view after `timeoutMs`.
 */
export async function waitForCase(
  baseUrl: string,
  location: string,
  done: (view: CaseView) => boolean,
  { apiKey = SOURCE_API_KEY, timeoutMs = 10_000 } = {},
): Promise<CaseView> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const res = await getCase(baseUrl, location, apiKey);
    last = await res.json();
    if (res.ok && done(last as CaseView)) return last as CaseView;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`case ${location} never reached the expected state; last view: ${JSON.stringify(last)}`);
}
