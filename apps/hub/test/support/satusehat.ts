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

/** Creates an Encounter for `visitKey` straight at the mock, as another client of the platform would. */
export async function createEncounterAtMock(mockBaseUrl: URL, visitKey: string): Promise<void> {
  const { patient, physician, location } = worldVisit;
  const tokenRes = await fetch(new URL('oauth2/v1/accesstoken?grant_type=client_credentials', mockBaseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: world.organization.clientId, client_secret: world.organization.clientSecret }),
  });
  const token: unknown = await tokenRes.json();
  if (typeof token !== 'object' || token === null || !('access_token' in token)) {
    throw new Error(`the mock issued no token: ${JSON.stringify(token)}`);
  }
  const res = await fetch(new URL('fhir-r4/v1/Encounter', mockBaseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${String(token.access_token)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
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
    }),
  });
  if (res.status !== 201) throw new Error(`planting an Encounter answered ${res.status}: ${await res.text()}`);
}
