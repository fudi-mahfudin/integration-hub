import { MockClient } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  satusehatEnv,
  WORLD_LOCATIONS,
  WORLD_SOURCE,
  WORLD_SOURCE_API_KEY,
  worldPatient,
  worldPhysician,
  worldVisitStarted,
  writeMappingSeed,
} from './support/satusehat.js';

/**
 * Step-time validation, the attempt log and pins (#28), seen through the case
 * view and the mock's request log.
 */
describe('step-time validation, attempt log and pins', () => {
  let mock: RunningMock;
  let mockClient: MockClient;
  let database: FreshDatabase;
  const running: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    mock = await startMock();
    mockClient = new MockClient(mock.baseUrl);
  });

  beforeEach(async () => {
    await mockClient.reset();
    database = await createFreshDatabase();
  });

  afterEach(async () => {
    for (const p of running.splice(0).reverse()) await p.close();
    await database?.drop();
  });

  afterAll(async () => {
    await mock?.close();
  });

  /** Boots a hub and a worker on this test's database; `env` is spread over the world env. */
  const boot = async (env: Record<string, string> = {}, seedPath?: string) => {
    const full = { ...satusehatEnv(mock.baseUrl, database.url, seedPath), ...env };
    const hub = await bootHub(full);
    running.push(hub);
    running.push(await bootWorker(full));
    return {
      send: (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body }),
      waitFor: (res: Response, done: (v: CaseView) => boolean) =>
        waitForCase(hub.baseUrl, res.headers.get('location') as string, done, { apiKey: WORLD_SOURCE_API_KEY }),
    };
  };
  const platformWrites = async () =>
    (await mockClient.log()).filter((e) => e.kind === 'platform' && e.method !== 'GET' && e.path !== '/oauth2/v1/accesstoken');

  it('an unmapped locationCode dead-letters create visit with MAPPING_MISSING, holds the case, and writes nothing', async () => {
    const { send, waitFor } = await boot();
    const event = worldVisitStarted({ data: { locationCode: 'NOT-MAPPED' } });

    const view = await waitFor(await send(event), (v) => v.status === 'dead_lettered');

    expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'MAPPING_MISSING', remote: null, pins: null });
    expect(view.steps.slice(1).map((s) => s.state)).toEqual(['awaiting_event', 'awaiting_event', 'awaiting_event']);
    expect(view.steps[0]!.attemptLog).toEqual([
      {
        attempt: 1,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        outcome: 'dead_lettered',
        errorCode: 'MAPPING_MISSING',
        httpStatus: null,
        used: { location: { localCode: 'NOT-MAPPED', locationId: null } },
        violations: [expect.objectContaining({ code: 'MAPPING_MISSING', mapping: { kind: 'location', localCode: 'NOT-MAPPED' } })],
        detail: null,
      },
    ]);
    expect(await platformWrites()).toEqual([]);
    expectAtMostOneStepInMotion(view);
  });

  it('a mapped Location id that is not a FHIR id dead-letters with PAYLOAD_INVALID before any write', async () => {
    // An operator typo in the mapping: the built Encounter fails the payload rules.
    const seed = writeMappingSeed([{ source: WORLD_SOURCE.id, locationCode: 'TYPO', locationId: 'not a fhir id!' }]);
    const { send, waitFor } = await boot({}, seed);

    const view = await waitFor(await send(worldVisitStarted({ data: { locationCode: 'TYPO' } })), (v) => v.status === 'dead_lettered');

    expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PAYLOAD_INVALID', pins: null });
    const [entry] = view.steps[0]!.attemptLog;
    expect(entry).toMatchObject({
      attempt: 1,
      outcome: 'dead_lettered',
      errorCode: 'PAYLOAD_INVALID',
      violations: [{ code: 'PAYLOAD_INVALID', rule: 'REFERENCE', path: 'Encounter.location[0].location.reference' }],
      used: {
        location: { localCode: 'TYPO', locationId: 'not a fhir id!' },
        patient: { ihsNumber: worldPatient.ihs, method: 'nik' },
        practitioner: { ihsNumber: worldPhysician.ihs, method: 'nik' },
      },
    });
    expect(await platformWrites()).toEqual([]);
    expectAtMostOneStepInMotion(view);
  });

  it('completion pins the IHS numbers and Location id it sent, and logs the attempt with its HTTP status', async () => {
    const { send, waitFor } = await boot();
    const event = worldVisitStarted({ data: { locationCode: WORLD_LOCATIONS[1]!.code } });

    const view = await waitFor(await send(event), (v) => v.steps[0]?.state === 'completed');

    expect(view.steps[0]!.pins).toEqual({
      patientIhs: worldPatient.ihs,
      practitionerIhs: worldPhysician.ihs,
      locationId: WORLD_LOCATIONS[1]!.id,
    });
    const [entry, ...more] = view.steps[0]!.attemptLog;
    expect(more).toEqual([]);
    expect(entry).toMatchObject({
      attempt: 1,
      outcome: 'completed',
      errorCode: null,
      httpStatus: 201,
      violations: [],
      used: {
        location: { localCode: WORLD_LOCATIONS[1]!.code, locationId: WORLD_LOCATIONS[1]!.id },
        patient: { ihsNumber: worldPatient.ihs, method: 'nik' },
        practitioner: { ihsNumber: worldPhysician.ihs, method: 'nik' },
      },
    });
    expect(Date.parse(entry!.startedAt)).toBeLessThanOrEqual(Date.parse(entry!.endedAt));
    expect(view.steps.slice(1).every((s) => s.pins === null && s.attemptLog.length === 0)).toBe(true);
  });

  it('logs every transient attempt, numbered in order, with its HTTP status', async () => {
    // A wrong client secret fails every token request.
    const { send, waitFor } = await boot({ SATUSEHAT_CLIENT_SECRET: 'wrong', WORKER_RETRY_DELAY_MS: '10' });

    const view = await waitFor(await send(worldVisitStarted()), (v) => (v.steps[0]?.attemptLog.length ?? 0) >= 3);

    const log = view.steps[0]!.attemptLog.slice(0, 3);
    expect(log.map((a) => a.attempt)).toEqual([1, 2, 3]);
    for (const a of log) {
      expect(a).toMatchObject({ outcome: 'retry_wait', errorCode: null, detail: expect.stringContaining('accesstoken') });
    }
    // The first token request is refused (401); the mock throttles the quick retries after it (429).
    expect(log[0]!.httpStatus).toBe(401);
    expect(log.slice(1).map((a) => a.httpStatus).every((s) => s === 401 || s === 429)).toBe(true);
    expect(view.steps[0]!.pins).toBeNull();
  });
});
