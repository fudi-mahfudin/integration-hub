import { MockClient } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  createEncounterDirectly,
  ENCOUNTER_SYSTEM,
  satusehatEnv,
  WORLD_LOCATIONS,
  WORLD_SOURCE_API_KEY,
  world,
  worldPatient,
  worldPhysician,
  worldVisitStarted,
} from './support/satusehat.js';

const createVisitDone = (v: CaseView) => v.steps[0]?.state === 'completed';

describe('create visit: an accepted visit.started becomes an Encounter at the mock', () => {
  let mock: RunningMock;
  let mockClient: MockClient;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await startMock();
    mockClient = new MockClient(mock.baseUrl);
    database = await createFreshDatabase();
    const env = satusehatEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });

  beforeEach(async () => {
    await mockClient.reset();
  });

  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
  const waitFor = (location: string, done: (v: CaseView) => boolean) =>
    waitForCase(hub.baseUrl, location, done, { apiKey: WORLD_SOURCE_API_KEY });

  it('creates exactly one Encounter, stores its remote id, and waits for prescription.written', async () => {
    const event = worldVisitStarted();

    const accepted = await send(event);
    expect(accepted.status).toBe(202);
    const view = await waitFor(accepted.headers.get('location') as string, createVisitDone);

    const created = (await mockClient.log({ visitKey: event.visitId, resourceType: 'Encounter' })).filter(
      (e) => e.effect === 'created',
    );
    expect(created).toHaveLength(1);
    const encounter = created[0]!.response.body as { id: string; meta: { versionId: string } };
    expect(view).toMatchObject({
      status: 'waiting',
      waitingFor: 'prescription.written',
      steps: [
        {
          step: 'create_visit',
          state: 'completed',
          attempts: 1,
          remote: { type: 'Encounter', id: encounter.id, version: encounter.meta.versionId },
        },
        { step: 'submit_prescription', state: 'awaiting_event', remote: null },
        { step: 'submit_dispense', state: 'awaiting_event' },
        { step: 'update_visit', state: 'awaiting_event' },
      ],
    });
    expect(view.waitingSince).not.toBeNull();
    expectAtMostOneStepInMotion(view);
  });

  it('sends UTC +00:00 times truncated to the second, and the mapped Location, source organization and IHS numbers', async () => {
    // 05:00:00.987 at +07:00 is the previous UTC day.
    const event = worldVisitStarted({
      data: { startedAt: '2026-01-01T05:00:00.987+07:00', locationCode: WORLD_LOCATIONS[2]!.code, encounterClass: 'EMER' },
    });

    const accepted = await send(event);
    await waitFor(accepted.headers.get('location') as string, createVisitDone);

    const [post] = (await mockClient.log({ visitKey: event.visitId, resourceType: 'Encounter' })).filter(
      (e) => e.method === 'POST',
    );
    expect(post?.request.body).toMatchObject({
      resourceType: 'Encounter',
      identifier: [{ system: ENCOUNTER_SYSTEM, value: event.visitId }],
      class: { code: 'EMER' },
      period: { start: '2025-12-31T22:00:00+00:00' },
      subject: { reference: `Patient/${worldPatient.ihs}` },
      participant: [{ individual: { reference: `Practitioner/${worldPhysician.ihs}` } }],
      location: [{ location: { reference: `Location/${WORLD_LOCATIONS[2]!.id}` } }],
      serviceProvider: { reference: `Organization/${world.organization.id}` },
    });
  });

  it('fetches one client_credentials token and reuses it across steps', async () => {
    const visits = [worldVisitStarted(), worldVisitStarted()];

    for (const event of visits) {
      const accepted = await send(event);
      await waitFor(accepted.headers.get('location') as string, createVisitDone);
    }

    const tokenRequests = (await mockClient.log()).filter((e) => e.path === '/oauth2/v1/accesstoken');
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.response.status).toBe(200);
  });

  it('dead-letters with REMOTE_RECORD_AMBIGUOUS when the search finds more than one Encounter, creating nothing', async () => {
    const event = worldVisitStarted();
    await createEncounterDirectly(mock.baseUrl, event.visitId);
    await createEncounterDirectly(mock.baseUrl, event.visitId);
    const before = await mockClient.log({ visitKey: event.visitId, resourceType: 'Encounter' });

    const accepted = await send(event);
    const view = await waitFor(accepted.headers.get('location') as string, (v) => v.status === 'dead_lettered');

    expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'REMOTE_RECORD_AMBIGUOUS', remote: null });
    expect(view.steps.slice(1).map((s) => s.state)).toEqual(['awaiting_event', 'awaiting_event', 'awaiting_event']);
    const after = await mockClient.log({ visitKey: event.visitId, resourceType: 'Encounter' });
    expect(after.slice(before.length).filter((e) => e.method === 'POST')).toEqual([]);
    expectAtMostOneStepInMotion(view);
  });

  it('a fresh hub database adopts the existing Encounter for the same visit, with no new create', async () => {
    const event = worldVisitStarted();
    const first = await send(event);
    const firstView = await waitFor(first.headers.get('location') as string, createVisitDone);

    const freshDb = await createFreshDatabase();
    const env = satusehatEnv(mock.baseUrl, freshDb.url);
    const freshHub = await bootHub(env);
    const freshWorker = await bootWorker(env);
    try {
      const again = await postEvent(freshHub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: event });
      const view = await waitForCase(freshHub.baseUrl, again.headers.get('location') as string, createVisitDone, {
        apiKey: WORLD_SOURCE_API_KEY,
      });

      const encounterLog = await mockClient.log({ visitKey: event.visitId, resourceType: 'Encounter' });
      expect(encounterLog.filter((e) => e.effect === 'created')).toHaveLength(1);
      expect(encounterLog.filter((e) => e.method === 'POST')).toHaveLength(1);
      expect(view.caseId).not.toBe(firstView.caseId);
      expect(view.steps[0]).toMatchObject({ state: 'completed', remote: firstView.steps[0]!.remote });
      expect(view).toMatchObject({ status: 'waiting', waitingFor: 'prescription.written' });
      expectAtMostOneStepInMotion(view);
    } finally {
      await freshWorker.close();
      await freshHub.close();
      await freshDb.drop();
    }
  });
});
