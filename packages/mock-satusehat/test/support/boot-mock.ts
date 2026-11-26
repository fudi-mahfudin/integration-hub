import { MockSatusehatClient } from '../../src/client.js';
import { createMockSatusehat } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';
import { DEFAULT_WORLD_PATH, loadWorld } from '../../src/world/world.js';

/** A mock booted for a test, listening on a random port. */
export interface BootedMock {
  baseUrl: URL;
  client: MockSatusehatClient;
  close(): Promise<void>;
}

/** A clock a test moves by hand. */
export interface ManualClock {
  (): Date;
  advance(ms: number): void;
}

/** Starts at a fixed instant and only moves when told. */
export function manualClock(start = new Date('2026-03-02T01:00:00Z')): ManualClock {
  let now = start.getTime();
  return Object.assign(() => new Date(now), { advance: (ms: number) => void (now += ms) });
}

/** Boots the mock through its composition root on a random port. `env` overrides its environment. */
export async function bootMock(env: Record<string, string> = {}, clock: () => Date = () => new Date()): Promise<BootedMock> {
  const mock = await createMockSatusehat(loadConfig({ HOST: '127.0.0.1', PORT: '0', ...env }), { clock });
  const baseUrl = await mock.listen();
  return { baseUrl, client: new MockSatusehatClient(baseUrl), close: () => mock.close() };
}

/** The world dataset as shipped: the same data the source simulator draws visits from. */
export const world = await loadWorld(DEFAULT_WORLD_PATH);

/** Requests a token the way the hub's adapter does. */
export async function requestToken(
  baseUrl: URL,
  credentials = { clientId: world.organization.clientId, clientSecret: world.organization.clientSecret },
  grantType = 'client_credentials',
): Promise<Response> {
  return fetch(new URL(`oauth2/v1/accesstoken?grant_type=${grantType}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret }),
  });
}

/** A valid access token. */
export async function accessToken(baseUrl: URL): Promise<string> {
  const res = await requestToken(baseUrl);
  if (res.status !== 200) throw new Error(`token request answered ${res.status}, expected 200`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('access_token' in body) || typeof body.access_token !== 'string') {
    throw new Error(`token response has no access_token: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/** A FHIR call with a bearer token. */
export async function fhir(baseUrl: URL, token: string | null, path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(`fhir-r4/v1/${path}`, baseUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A create-visit Encounter for the organization in the world, with a unique visit identifier. */
export function encounter(visitKey = `V-${crypto.randomUUID()}`, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const org = world.organization.id;
  const [patient] = world.patients;
  const [practitioner] = world.practitioners;
  const [location] = world.locations;
  return {
    resourceType: 'Encounter',
    identifier: [{ system: `http://sys-ids.kemkes.go.id/encounter/${org}`, value: visitKey }],
    status: 'arrived',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: { reference: `Patient/${patient?.ihsNumber}` },
    participant: [{ individual: { reference: `Practitioner/${practitioner?.ihsNumber}` } }],
    period: { start: '2026-03-02T01:00:00+00:00' },
    location: [{ location: { reference: `Location/${location?.id}` } }],
    statusHistory: [{ status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00' } }],
    serviceProvider: { reference: `Organization/${org}` },
    ...overrides,
  };
}

/** The `id` of a created record, read from its 201 body. */
export async function createdId(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (res.status !== 201 || typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string') {
    throw new Error(`expected a 201 with an id, got ${res.status} ${JSON.stringify(body)}`);
  }
  return body.id;
}

/** A MedicationRequest for Paracetamol 500 mg tablets (92000001) on Encounter `encounterId`, under prescription `prescriptionId`. */
export function medicationRequest(
  encounterId: string,
  prescriptionId = `RX-${crypto.randomUUID()}`,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const org = world.organization.id;
  const [patient] = world.patients;
  const [practitioner] = world.practitioners;
  return {
    resourceType: 'MedicationRequest',
    contained: [
      {
        resourceType: 'Medication',
        id: 'medication',
        code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '92000001', display: 'Parasetamol 500 mg Tablet' }] },
      },
    ],
    identifier: [
      { system: `http://sys-ids.kemkes.go.id/prescription/${org}`, use: 'official', value: prescriptionId },
      { system: `http://sys-ids.kemkes.go.id/prescription-item/${org}`, use: 'official', value: `${prescriptionId}-1` },
    ],
    status: 'completed',
    intent: 'order',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community' }] }],
    medicationReference: { reference: '#medication' },
    subject: { reference: `Patient/${patient?.ihsNumber}` },
    encounter: { reference: `Encounter/${encounterId}` },
    authoredOn: '2026-03-02T01:10:00+00:00',
    requester: { reference: `Practitioner/${practitioner?.ihsNumber}` },
    dispenseRequest: {
      quantity: { value: 10, unit: 'Tablet', system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: 'BS066' },
      performer: { reference: `Organization/${org}` },
    },
    substitution: { allowedBoolean: true },
    ...overrides,
  };
}

/**
 * A dispense of Paracetamol 500 mg (Fiktif Farma A, 93000001), a child of
 * the 92000001 `medicationRequest()` prescribes, so not a substitution;
 * authorized by MedicationRequest `medicationRequestId` on Encounter
 * `encounterId`, under prescription `prescriptionId`.
 */
export function medicationDispense(
  encounterId: string,
  medicationRequestId: string,
  prescriptionId = `RX-${crypto.randomUUID()}`,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const org = world.organization.id;
  const [patient] = world.patients;
  const pharmacist = world.practitioners.find((p) => p.role === 'pharmacist');
  return {
    resourceType: 'MedicationDispense',
    contained: [
      {
        resourceType: 'Medication',
        id: 'medication',
        code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: '93000001', display: 'Parasetamol 500 mg Tablet (Fiktif Farma A)' }] },
        batch: { lotNumber: 'LOT-1', expirationDate: '2027-04-24' },
      },
    ],
    identifier: [
      { system: `http://sys-ids.kemkes.go.id/prescription/${org}`, use: 'official', value: prescriptionId },
      { system: `http://sys-ids.kemkes.go.id/prescription-item/${org}`, use: 'official', value: `${prescriptionId}-1` },
    ],
    status: 'completed',
    medicationReference: { reference: '#medication' },
    subject: { reference: `Patient/${patient?.ihsNumber}` },
    context: { reference: `Encounter/${encounterId}` },
    performer: [{ actor: { reference: `Practitioner/${pharmacist?.ihsNumber}` } }],
    authorizingPrescription: [{ reference: `MedicationRequest/${medicationRequestId}` }],
    quantity: { value: 10, unit: 'Tablet', system: 'http://terminology.kemkes.go.id/CodeSystem/medication-form', code: 'BS066' },
    whenPrepared: '2026-03-02T01:20:00+00:00',
    whenHandedOver: '2026-03-02T01:30:00+00:00',
    substitution: { wasSubstituted: false },
    ...overrides,
  };
}
