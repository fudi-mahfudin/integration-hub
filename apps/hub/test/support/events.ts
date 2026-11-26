import { z } from 'zod';
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

/** One drug item of a `prescription.written`, with fake values; overrides are shallow-merged. */
export function prescriptionItem(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'ITEM-1',
    drugCode: 'PCT500',
    quantity: 10,
    dosage: { text: '3 x 1 tablet sesudah makan', timesPerDay: 3, doseAmount: 1, routeCode: 'O' },
    ...overrides,
  };
}

/** A valid single-item `prescription.written` envelope with fake values; `data` overrides are shallow-merged. */
export function prescriptionWritten(overrides: { visitId?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: 'prescription.written',
    visitId: overrides.visitId ?? newVisitId(),
    occurredAt: '2026-03-02T08:10:00+07:00',
    data: {
      prescriptionId: 'RX-1',
      authoredAt: '2026-03-02T08:10:00+07:00',
      requester: { nik: '7209061211900001' },
      items: [prescriptionItem()],
      ...overrides.data,
    },
  };
}

/** A valid `drug.dispensed` envelope with fake values, for `prescriptionWritten()`'s defaults; `data` overrides are shallow-merged. */
export function drugDispensed(overrides: { visitId?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: 'drug.dispensed',
    visitId: overrides.visitId ?? newVisitId(),
    occurredAt: '2026-03-02T08:30:00+07:00',
    data: {
      prescriptionId: 'RX-1',
      itemId: 'ITEM-1',
      drugCode: 'PCT500-FFA',
      quantity: 10,
      preparedAt: '2026-03-02T08:20:00+07:00',
      handedOverAt: '2026-03-02T08:30:00+07:00',
      pharmacist: { nik: '7209061505710030' },
      batch: { lot: 'LOT-1', expiry: '2027-04-24' },
      ...overrides.data,
    },
  };
}

/** A valid `visit.finished` envelope, an hour after `visitStarted()`'s start; `data` overrides are shallow-merged. */
export function visitFinished(overrides: { visitId?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: 'visit.finished',
    visitId: overrides.visitId ?? newVisitId(),
    occurredAt: '2026-03-02T09:00:00+07:00',
    data: { finishedAt: '2026-03-02T09:00:00+07:00', ...overrides.data },
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

const remoteSchema = z.object({ type: z.string(), id: z.string(), version: z.string().nullable() });

/** `GET /v1/cases/{id}` as tests read it. */
export const caseViewSchema = z.object({
  caseId: z.string(),
  visitId: z.string(),
  status: z.string(),
  waitingFor: z.string().nullable(),
  waitingSince: z.string().nullable(),
  rejections: z.array(z.object({ code: z.string(), eventType: z.string(), rejectedAt: z.string() })),
  steps: z.array(
    z.object({
      step: z.string(),
      eventType: z.string(),
      state: z.string(),
      attempts: z.number().int(),
      deadLetterReason: z.string().nullable(),
      remote: remoteSchema.nullable(),
      pins: z.record(z.string(), z.unknown()).nullable(),
      attemptLog: z.array(
        z.object({
          attempt: z.number().int(),
          startedAt: z.string(),
          endedAt: z.string(),
          outcome: z.string(),
          errorCode: z.string().nullable(),
          httpStatus: z.number().int().nullable(),
          valuesUsed: z.record(z.string(), z.unknown()),
          lookupMethods: z.record(z.string(), z.string()),
          violations: z.array(z.object({ code: z.string(), path: z.string().nullable(), message: z.string() })),
        }),
      ),
    }),
  ),
});

/** A case as `GET /v1/cases/{id}` shows it. */
export type CaseView = z.infer<typeof caseViewSchema>;

/** Polls `GET /v1/cases/{id}` until `done` holds for the case, and resolves to it. Fails after `timeoutMs`. */
export async function waitForCase(
  baseUrl: URL,
  location: string | null,
  done: (view: CaseView) => boolean,
  options: { apiKey: string; timeoutMs?: number },
): Promise<CaseView> {
  const caseId = location?.split('/').at(-1);
  if (!caseId) throw new Error(`expected a Location header naming a case, got ${JSON.stringify(location)}`);
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  let last: unknown;
  while (Date.now() < deadline) {
    const res = await getCase(baseUrl, caseId, options.apiKey);
    last = await res.json();
    const view = caseViewSchema.safeParse(last);
    if (res.status === 200 && view.success && done(view.data)) return view.data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`case ${caseId} did not reach the expected state; last seen ${JSON.stringify(last)}`);
}
