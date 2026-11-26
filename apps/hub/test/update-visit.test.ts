import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  type BootedMock,
  bootMock,
  ENCOUNTER_SYSTEM,
  updateEncounterAtMock,
  world,
  WORLD_SOURCE_API_KEY,
  worldEnv,
  worldVisit,
  worldVisitEvents,
} from './support/satusehat.js';

const settled = (v: CaseView) => ['completed', 'dead_lettered'].includes(v.status);

describe('update visit: a visit.finished closes the case’s Encounter, and the case completes', () => {
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

  // The mock is never reset here (a reset revokes the worker's token); each test uses a fresh visit id.
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });


  it('delivers four events as Encounter created → MedicationRequest created → MedicationDispense created → Encounter updated, each once', async () => {
    const { visit, events } = worldVisitEvents();
    let location: string | null = null;
    for (const event of events) location = (await send(event)).headers.get('location');

    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });

    const effects = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
      'Encounter created',
      'MedicationRequest created',
      'MedicationDispense created',
      'Encounter updated',
    ]);
    expect(await mock.client.report()).toEqual({ faultSeed: null, duplicates: [], outOfOrder: [], overlap: [] });
    expect(view).toMatchObject({ status: 'completed', waitingFor: null, waitingSince: null });
    expect(view.steps.map((s) => s.state)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expectAtMostOneStepInMotion(view);
  });

  it('PUTs the same Encounter, finished, from the values create visit pinned, without a diagnosis, and stores its new version', async () => {
    const { visit, events } = worldVisitEvents();
    let location: string | null = null;
    for (const event of events) location = (await send(event)).headers.get('location');
    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });

    const encounterId = view.steps[0]?.remote?.id;
    const puts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe(`/fhir-r4/v1/Encounter/${encounterId}`);
    expect(puts[0]?.response.status).toBe(200);
    expect(puts[0]?.request.body).toEqual({
      resourceType: 'Encounter',
      id: encounterId,
      identifier: [{ system: ENCOUNTER_SYSTEM, value: visit.visitId }],
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      subject: { reference: `Patient/${worldVisit.patient.ihsNumber}` },
      participant: [
        {
          type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' }] }],
          individual: { reference: `Practitioner/${worldVisit.physician.ihsNumber}` },
        },
      ],
      // 08:00 and 09:00:00.500 at +07:00, in UTC, truncated to the second.
      period: { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T02:00:00+00:00' },
      location: [{ location: { reference: `Location/${worldVisit.location.id}` } }],
      statusHistory: [
        { status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T02:00:00+00:00' } },
        { status: 'finished', period: { start: '2026-03-02T02:00:00+00:00', end: '2026-03-02T02:00:00+00:00' } },
      ],
      serviceProvider: { reference: `Organization/${world.organization.id}` },
    });
    const pins = view.steps[0]?.pins;
    expect(view.steps[3]).toMatchObject({ step: 'update_visit', state: 'completed', remote: { type: 'Encounter', id: encounterId, version: '2' }, pins });
    expect(view.steps[3]?.attemptLog).toEqual([
      expect.objectContaining({ outcome: 'completed', httpStatus: 200, valuesUsed: pins, lookupMethods: {}, violations: [] }),
    ]);
  });

  it('carries each earlier step’s remote identifiers in every later payload', async () => {
    const { visit, events } = worldVisitEvents();
    let location: string | null = null;
    for (const event of events) location = (await send(event)).headers.get('location');
    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });

    const writes = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    const [encounterCreated, requestCreated, dispenseCreated, encounterUpdated] = writes;
    const idOf = (body: unknown) => (typeof body === 'object' && body !== null && 'id' in body ? body.id : undefined);
    const encounterId = idOf(encounterCreated?.response.body);
    const requestId = idOf(requestCreated?.response.body);
    expect([encounterId, requestId, idOf(dispenseCreated?.response.body)]).toEqual(view.steps.slice(0, 3).map((s) => s.remote?.id));
    expect(requestCreated?.request.body).toMatchObject({ encounter: { reference: `Encounter/${encounterId}` } });
    expect(dispenseCreated?.request.body).toMatchObject({
      context: { reference: `Encounter/${encounterId}` },
      authorizingPrescription: [{ reference: `MedicationRequest/${requestId}` }],
    });
    expect(encounterUpdated?.path).toBe(`/fhir-r4/v1/Encounter/${encounterId}`);
    expect(encounterUpdated?.request.body).toMatchObject({ id: encounterId });
  });

  it('holds a visit.finished that arrives first, then completes the case after the other three steps', async () => {
    const { visit, events } = worldVisitEvents();
    const finished = events.at(-1);
    const first = await send(finished);
    for (const event of events.slice(0, -1)) await send(event);

    const view = await waitForCase(hub.baseUrl, first.headers.get('location'), settled, { apiKey: WORLD_SOURCE_API_KEY });

    expect(view.status).toBe('completed');
    const effects = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
      'Encounter created',
      'MedicationRequest created',
      'MedicationDispense created',
      'Encounter updated',
    ]);
  });

  it('adopts an update already at SATUSEHAT (the Encounter finished at the same end), sending no PUT of its own', async () => {
    const { visit, events } = worldVisitEvents();
    const finished = events.at(-1);
    let location: string | null = null;
    for (const event of events.slice(0, -1)) location = (await send(event)).headers.get('location');
    const dispensed = await waitForCase(hub.baseUrl, location, (v) => v.steps[2]?.state === 'completed', { apiKey: WORLD_SOURCE_API_KEY });
    const [created] = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.effect === 'created');
    const end = '2026-03-02T02:00:00+00:00';
    const body = { ...Object(created?.response.body), status: 'finished', period: { start: '2026-03-02T01:00:00+00:00', end } };
    const version = await updateEncounterAtMock(mock.baseUrl, { ...body, id: dispensed.steps[0]?.remote?.id ?? '' });

    await send(finished);
    const view = await waitForCase(hub.baseUrl, location, settled, { apiKey: WORLD_SOURCE_API_KEY });

    expect(view.status).toBe('completed');
    expect(view.steps[3]).toMatchObject({ state: 'completed', remote: { type: 'Encounter', id: dispensed.steps[0]?.remote?.id, version } });
    expect(view.steps[3]?.attemptLog).toEqual([expect.objectContaining({ outcome: 'completed', httpStatus: 200 })]);
    const puts = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'PUT');
    expect(puts).toHaveLength(1);
  });
});
