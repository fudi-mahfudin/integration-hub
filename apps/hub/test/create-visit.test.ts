import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  bootMock,
  createEncounterAtMock,
  ENCOUNTER_SYSTEM,
  world,
  WORLD_SOURCE_API_KEY,
  worldEnv,
  worldVisit,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';

const createVisitSettled = (v: CaseView) => v.steps[0]?.state === 'completed' || v.steps[0]?.state === 'dead_lettered';

describe('create visit: an accepted visit.started becomes an Encounter at the mock', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });

  // The mock is never reset here: a reset revokes the worker's token (401 handling lands with #35).
  // Every test uses a fresh visit id and reads the log by its visit key instead.
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
  const settled = (res: Response) =>
    waitForCase(hub.baseUrl, res.headers.get('location'), createVisitSettled, { apiKey: WORLD_SOURCE_API_KEY });

  it('creates exactly one Encounter, stores its remote id, and waits for prescription.written', async () => {
    const event = worldVisitStarted();

    const view = await settled(await send(event));

    const created = (await mock.client.log({ visitKey: event.visitId, resourceType: 'Encounter' })).filter(
      (e) => e.effect === 'created',
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.response.body).toMatchObject({ id: expect.any(String), meta: { versionId: expect.any(String) } });
    const encounter = encounterOf(created[0]?.response.body);
    expect(view).toMatchObject({
      status: 'waiting',
      waitingFor: 'prescription.written',
      waitingSince: expect.any(String),
      steps: [
        {
          step: 'create_visit',
          state: 'completed',
          attempts: 1,
          remote: { type: 'Encounter', id: encounter.id, version: encounter.versionId },
        },
        { step: 'submit_prescription', state: 'awaiting_event', remote: null },
        { step: 'submit_dispense', state: 'awaiting_event', remote: null },
        { step: 'update_visit', state: 'awaiting_event', remote: null },
      ],
    });
    expectAtMostOneStepInMotion(view);
  });

  it('logs the attempt and pins the IHS numbers and Location ID it sent', async () => {
    const event = worldVisitStarted();

    const view = await settled(await send(event));

    const sent = {
      patientIhsNumber: worldVisit.patient.ihsNumber,
      practitionerIhsNumber: worldVisit.physician.ihsNumber,
      locationId: worldVisit.location.id,
    };
    const [createVisitStep, ...later] = view.steps;
    expect(createVisitStep).toMatchObject({ state: 'completed', pins: sent });
    expect(createVisitStep?.attemptLog).toEqual([
      {
        attempt: 1,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        outcome: 'completed',
        errorCode: null,
        httpStatus: 201,
        valuesUsed: sent,
        lookupMethods: { patient: 'nik', practitioner: 'nik' },
        violations: [],
        readRetries: [],
      },
    ]);
    const [attempt] = createVisitStep?.attemptLog ?? [];
    expect(Date.parse(attempt?.startedAt ?? '')).toBeLessThanOrEqual(Date.parse(attempt?.endedAt ?? ''));
    for (const step of later) expect(step).toMatchObject({ pins: null, attemptLog: [] });
  });

  it('sends +00:00 times truncated to the second on the UTC date, with the mapped Location, the source organization and the IHS numbers', async () => {
    const location = world.locations[2];
    // 05:00:00.987 at +07:00 on 1 January is 22:00:00 UTC on 31 December.
    const event = worldVisitStarted({
      startedAt: '2026-01-01T05:00:00.987+07:00',
      locationCode: location?.code,
      encounterClass: 'EMER',
    });

    await settled(await send(event));

    const posts = (await mock.client.log({ visitKey: event.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.request.body).toMatchObject({
      resourceType: 'Encounter',
      identifier: [{ system: ENCOUNTER_SYSTEM, value: event.visitId }],
      status: 'arrived',
      class: { code: 'EMER' },
      subject: { reference: `Patient/${worldVisit.patient.ihsNumber}` },
      participant: [{ individual: { reference: `Practitioner/${worldVisit.physician.ihsNumber}` } }],
      period: { start: '2025-12-31T22:00:00+00:00' },
      statusHistory: [{ status: 'arrived', period: { start: '2025-12-31T22:00:00+00:00' } }],
      location: [{ location: { reference: `Location/${location?.id}` } }],
      serviceProvider: { reference: `Organization/${world.organization.id}` },
    });
  });

  it('the same visit sent to a fresh hub database adopts the existing Encounter, with no new create', async () => {
    const event = worldVisitStarted();
    const first = await settled(await send(event));

    const freshDatabase = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, freshDatabase.url);
    const freshHub = await bootHub(env);
    const freshWorker = await bootWorker(env);
    try {
      const res = await postEvent(freshHub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: event });
      const view = await waitForCase(freshHub.baseUrl, res.headers.get('location'), createVisitSettled, {
        apiKey: WORLD_SOURCE_API_KEY,
      });

      const encounterLog = await mock.client.log({ visitKey: event.visitId, resourceType: 'Encounter' });
      expect(encounterLog.filter((e) => e.method === 'POST')).toHaveLength(1);
      expect(encounterLog.filter((e) => e.effect === 'created')).toHaveLength(1);
      expect(view.caseId).not.toBe(first.caseId);
      expect(view).toMatchObject({ status: 'waiting', waitingFor: 'prescription.written' });
      expect(view.steps[0]).toMatchObject({ state: 'completed', remote: first.steps[0]?.remote });
      expectAtMostOneStepInMotion(view);
    } finally {
      await freshWorker.close();
      await freshHub.close();
      await freshDatabase.drop();
    }
  });

  it('dead-letters with REMOTE_RECORD_AMBIGUOUS when more than one Encounter has the visit identifier, creating nothing', async () => {
    const event = worldVisitStarted();
    await createEncounterAtMock(mock.baseUrl, event.visitId);
    await createEncounterAtMock(mock.baseUrl, event.visitId);

    const view = await settled(await send(event));

    expect(view.status).toBe('dead_lettered');
    expect(view.waitingFor).toBeNull();
    expect(view.steps.map((s) => [s.step, s.state])).toEqual([
      ['create_visit', 'dead_lettered'],
      ['submit_prescription', 'awaiting_event'],
      ['submit_dispense', 'awaiting_event'],
      ['update_visit', 'awaiting_event'],
    ]);
    expect(view.steps[0]).toMatchObject({ deadLetterReason: 'REMOTE_RECORD_AMBIGUOUS', remote: null });
    const created = (await mock.client.log({ visitKey: event.visitId, resourceType: 'Encounter' })).filter(
      (e) => e.effect === 'created',
    );
    expect(created).toHaveLength(2);
    expectAtMostOneStepInMotion(view);
  });

  it('dead-letters with MAPPING_MISSING when the location code has no mapping, and sends nothing for the visit', async () => {
    const event = worldVisitStarted({ locationCode: 'NOT-MAPPED' });

    const view = await settled(await send(event));

    expect(view.status).toBe('dead_lettered');
    expect(view.steps.map((s) => s.state)).toEqual(['dead_lettered', 'awaiting_event', 'awaiting_event', 'awaiting_event']);
    expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'MAPPING_MISSING', pins: null, remote: null });
    expect(view.steps[0]?.attemptLog).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'dead_lettered',
        errorCode: 'MAPPING_MISSING',
        httpStatus: null,
        valuesUsed: {},
        violations: [{ code: 'MAPPING_MISSING', path: null, message: expect.stringContaining('"NOT-MAPPED"') }],
      }),
    ]);
    expect(await mock.client.log({ visitKey: event.visitId })).toEqual([]);
    expectAtMostOneStepInMotion(view);
  });

  it('logs an attempt that fails without an outcome with what it had resolved, and sends the step to retry_wait', async () => {
    // The practitioner search answers 503 on all three tries, after the patient was found: the attempt ends
    // without an outcome. Its Retry-After keeps the step waiting while the test reads it.
    await mock.client.setFaults({
      seed: 32,
      rules: [
        {
          id: 'practitioner-search-fails',
          match: { method: 'GET', resourceType: 'Practitioner' },
          firstN: 3,
          kind: 'http_503',
          params: { retryAfter: { form: 'seconds', seconds: 30 } },
        },
      ],
    });
    const event = worldVisitStarted();

    const view = await waitForCase(hub.baseUrl, (await send(event)).headers.get('location'), (v) => (v.steps[0]?.attemptLog.length ?? 0) > 0, {
      apiKey: WORLD_SOURCE_API_KEY,
    });
    await mock.client.setFaults({ seed: 32, rules: [] });

    expect(view.steps[0]).toMatchObject({ state: 'retry_wait', deadLetterReason: null, pins: null });
    expect(view.steps[0]?.attemptLog).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'failed',
        errorCode: null,
        httpStatus: 503,
        valuesUsed: { locationId: worldVisit.location.id, patientIhsNumber: worldVisit.patient.ihsNumber },
        lookupMethods: { patient: 'nik' },
      }),
    ]);
    expect(await mock.client.log({ visitKey: event.visitId })).toEqual([]);
  });

  it('dead-letters with PATIENT_NOT_FOUND when no patient has the NIK, creating nothing', async () => {
    const event = worldVisitStarted({ patient: { nik: '9271069999999999', mrn: 'MRN-0002' } });

    const view = await settled(await send(event));

    expect(view.status).toBe('dead_lettered');
    expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PATIENT_NOT_FOUND', pins: null });
    expect(view.steps[0]?.attemptLog).toEqual([
      expect.objectContaining({
        outcome: 'dead_lettered',
        errorCode: 'PATIENT_NOT_FOUND',
        httpStatus: 200,
        valuesUsed: { locationId: worldVisit.location.id },
        lookupMethods: {},
        violations: [],
      }),
    ]);
    expect(await mock.client.log({ visitKey: event.visitId })).toEqual([]);
  });
});

/** The id and versionId of an Encounter body the mock answered with. */
function encounterOf(body: unknown): { id: string; versionId: string } {
  const id: unknown = typeof body === 'object' && body !== null && 'id' in body ? body.id : undefined;
  const meta: unknown = typeof body === 'object' && body !== null && 'meta' in body ? body.meta : undefined;
  const versionId: unknown = typeof meta === 'object' && meta !== null && 'versionId' in meta ? meta.versionId : undefined;
  if (typeof id !== 'string' || typeof versionId !== 'string') throw new Error(`not a stored Encounter: ${JSON.stringify(body)}`);
  return { id, versionId };
}
