import { MockSatusehatClient } from '@integration-hub/mock-satusehat/client';
import { createMockSatusehat } from '@integration-hub/mock-satusehat/server';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { randomUUID } from 'node:crypto';

/** The world dataset the mock answers from and the location mapping seed points at. */
export const world = await loadWorld(DEFAULT_WORLD_PATH);

/** The API key of the world's source system, registered by `worldEnv`. */
export const WORLD_SOURCE_API_KEY = 'world-source-key';

/** The `encounter/{org}` identifier system of the world's organization. */
export const ENCOUNTER_SYSTEM = `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}`;

/** A mock SATUSEHAT booted for a test. */
export interface BootedMock {
  baseUrl: URL;
  client: MockSatusehatClient;
  close(): Promise<void>;
}

/** Boots the mock SATUSEHAT through its composition root on a random port. */
export async function bootMock(): Promise<BootedMock> {
  const mock = await createMockSatusehat(
    {
      host: '127.0.0.1',
      port: 0,
      worldPath: DEFAULT_WORLD_PATH,
      tokenExpiresInSeconds: 3599,
      tokenThrottleWindowSeconds: 60,
    },
    { clock: () => new Date() },
  );
  const baseUrl = await mock.listen();
  return { baseUrl, client: new MockSatusehatClient(baseUrl), close: () => mock.close() };
}

/**
 * The environment a hub and worker need to deliver the world's visits to
 * `mock`: one source system, `simulator` (the source the location mapping
 * seed is for), belonging to the world's organization, a fresh database, and
 * a fast worker poll.
 */
export function worldEnv(mockBaseUrl: URL, databaseUrl: string): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    HUB_SOURCES: JSON.stringify([
      { id: 'simulator', organizationId: world.organization.id, apiKey: WORLD_SOURCE_API_KEY },
    ]),
    SATUSEHAT_AUTH_URL: new URL('oauth2/v1/', mockBaseUrl).href,
    SATUSEHAT_FHIR_URL: new URL('fhir-r4/v1/', mockBaseUrl).href,
    SATUSEHAT_KFA_URL: new URL('kfa-v2/', mockBaseUrl).href,
    SATUSEHAT_CLIENT_ID: world.organization.clientId,
    SATUSEHAT_CLIENT_SECRET: world.organization.clientSecret,
    WORKER_POLL_INTERVAL_MS: '20',
  };
}

/** The world records a `worldVisitStarted()` names. */
export const worldVisit = (() => {
  const [patient] = world.patients;
  const physician = world.practitioners.find((p) => p.role === 'physician');
  const [location] = world.locations;
  if (!patient || !physician || !location) throw new Error('the world dataset needs a patient, a physician and a location');
  return { patient, physician, location };
})();

/** A `visit.started` for a world patient, physician and location, with a fresh visit id. */
export function worldVisitStarted(data: Record<string, unknown> = {}) {
  const { patient, physician, location } = worldVisit;
  return {
    type: 'visit.started',
    visitId: `V-${randomUUID()}`,
    occurredAt: '2026-03-02T08:00:00+07:00',
    data: {
      patient: { nik: patient.nik, mrn: 'MRN-0001' },
      practitioner: { nik: physician.nik },
      encounterClass: 'AMB',
      locationCode: location.code,
      startedAt: '2026-03-02T08:00:00+07:00',
      ...data,
    },
  };
}

/** The `prescription/{org}` identifier system of the world's organization. */
export const PRESCRIPTION_SYSTEM = `http://sys-ids.kemkes.go.id/prescription/${world.organization.id}`;

/**
 * A single-item `prescription.written` for `visitId`, requested by the world's
 * physician. The default drug code `PCT500` maps to KFA 92000001
 * (Parasetamol 500 mg Tablet) in the drug mapping seed; `item` overrides are
 * shallow-merged into the one item.
 */
export function worldPrescriptionWritten(
  visitId: string,
  overrides: { data?: Record<string, unknown>; item?: Record<string, unknown> } = {},
) {
  return {
    type: 'prescription.written',
    visitId,
    occurredAt: '2026-03-02T08:10:00+07:00',
    data: {
      prescriptionId: `RX-${randomUUID()}`,
      authoredAt: '2026-03-02T08:10:00.750+07:00',
      requester: { nik: worldVisit.physician.nik },
      items: [
        {
          itemId: 'ITEM-1',
          drugCode: 'PCT500',
          quantity: 10,
          dosage: { text: '3 x 1 tablet sesudah makan', timesPerDay: 3, doseAmount: 1, routeCode: 'O' },
          ...overrides.item,
        },
      ],
      ...overrides.data,
    },
  };
}

/** POSTs a resource straight to the mock, as another client of the platform would; resolves to the 201 body's id. */
async function createAtMock(mockBaseUrl: URL, resourceType: string, body: unknown): Promise<string> {
  const tokenRes = await fetch(new URL('oauth2/v1/accesstoken?grant_type=client_credentials', mockBaseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: world.organization.clientId, client_secret: world.organization.clientSecret }),
  });
  const token: unknown = await tokenRes.json();
  if (typeof token !== 'object' || token === null || !('access_token' in token)) {
    throw new Error(`the mock issued no token: ${JSON.stringify(token)}`);
  }
  const res = await fetch(new URL(`fhir-r4/v1/${resourceType}`, mockBaseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${String(token.access_token)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const created: unknown = await res.json();
  const id: unknown = typeof created === 'object' && created !== null && 'id' in created ? created.id : undefined;
  if (res.status !== 201 || typeof id !== 'string') throw new Error(`planting a ${resourceType} answered ${res.status}: ${JSON.stringify(created)}`);
  return id;
}

/** Creates an Encounter for `visitKey` straight at the mock, as another client of the platform would. */
export async function createEncounterAtMock(mockBaseUrl: URL, visitKey: string): Promise<void> {
  const { patient, physician, location } = worldVisit;
  await createAtMock(mockBaseUrl, 'Encounter', {
    resourceType: 'Encounter',
    identifier: [{ system: ENCOUNTER_SYSTEM, value: visitKey }],
    status: 'arrived',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: { reference: `Patient/${patient.ihsNumber}` },
    participant: [{ individual: { reference: `Practitioner/${physician.ihsNumber}` } }],
    period: { start: '2026-03-02T01:00:00+00:00' },
    location: [{ location: { reference: `Location/${location.id}` } }],
    statusHistory: [{ status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00' } }],
    serviceProvider: { reference: `Organization/${world.organization.id}` },
  });
}

/**
 * Creates a MedicationRequest for prescription `prescriptionId` on Encounter
 * `encounterId` straight at the mock, as another client of the platform
 * would; resolves to its id.
 */
export function createMedicationRequestAtMock(mockBaseUrl: URL, encounterId: string, prescriptionId: string): Promise<string> {
  const org = world.organization.id;
  return createAtMock(mockBaseUrl, 'MedicationRequest', {
    resourceType: 'MedicationRequest',
    contained: [{ resourceType: 'Medication', id: 'medication', code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '92000001' }] } }],
    identifier: [
      { system: PRESCRIPTION_SYSTEM, value: prescriptionId },
      { system: `http://sys-ids.kemkes.go.id/prescription-item/${org}`, value: 'ITEM-1' },
    ],
    status: 'completed',
    intent: 'order',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community' }] }],
    medicationReference: { reference: '#medication' },
    subject: { reference: `Patient/${worldVisit.patient.ihsNumber}` },
    encounter: { reference: `Encounter/${encounterId}` },
    authoredOn: '2026-03-02T01:10:00+00:00',
    requester: { reference: `Practitioner/${worldVisit.physician.ihsNumber}` },
    dispenseRequest: { performer: { reference: `Organization/${org}` } },
  });
}
