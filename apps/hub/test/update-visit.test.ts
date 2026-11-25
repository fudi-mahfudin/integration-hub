import { MockClient, type LogEntry } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  ENCOUNTER_SYSTEM,
  satusehatEnv,
  world,
  WORLD_DRUGS,
  WORLD_LOCATIONS,
  WORLD_SOURCE,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldPatient,
  worldPhysician,
  worldPrescriptionWritten,
  worldVisitFinished,
  worldVisitStarted,
  writeMappingSeed,
} from './support/satusehat.js';

const drugs = () => WORLD_DRUGS.map((d) => ({ source: WORLD_SOURCE.id, drugCode: d.code, kfaCode: d.product.code }));
const settled = (v: CaseView) => v.status === 'completed' || v.status === 'dead_lettered';
const effects = (log: LogEntry[]) => log.filter((e) => e.kind === 'platform' && e.effect !== 'none');

/** Update visit (#31): `visit.finished` → the case's Encounter PUT as finished; the case completes. */
describe('update visit', () => {
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

  const boot = async (env: Record<string, string> = {}) => {
    const all = { ...satusehatEnv(mock.baseUrl, database.url), WORKER_RETRY_DELAY_MS: '50', ...env };
    const hub = await bootHub(all);
    running.push(hub);
    running.push(await bootWorker(all));
    const send = async (body: unknown) => {
      const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
      expect(res.status, await res.clone().text()).toBe(202);
      return res.headers.get('location') as string;
    };
    const wait = async (location: string, done: (v: CaseView) => boolean = settled) => {
      const view = await waitForCase(hub.baseUrl, location, done, { apiKey: WORLD_SOURCE_API_KEY });
      expectAtMostOneStepInMotion(view);
      return view;
    };
    return { hub, send, wait };
  };

  it('four events → the case completes; the mock saw each effect once, in order, and reports nothing', async () => {
    const { send, wait } = await boot();
    const visitId = `V-${crypto.randomUUID()}`;

    const location = await send(worldVisitStarted({ visitId }));
    await send(worldPrescriptionWritten(visitId));
    await send(worldDrugDispensed(visitId));
    await send(worldVisitFinished(visitId));
    const view = await wait(location);

    const done = effects(await mockClient.log({ visitKey: visitId }));
    expect(done.map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
      'Encounter created',
      'MedicationRequest created',
      'MedicationDispense created',
      'Encounter updated',
    ]);
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [], overlappingInFlight: [] });

    const encounter = done[0]!.response.body as { id: string; meta: { versionId: string } };
    const updated = done[3]!.response.body as { id: string; meta: { versionId: string } };
    expect(view).toMatchObject({ status: 'completed', waitingFor: null });
    expect(view.steps.map((s) => s.state)).toEqual(['completed', 'completed', 'completed', 'completed']);
    // The same Encounter, its new version stored as remote_version.
    expect(updated.id).toBe(encounter.id);
    expect(updated.meta.versionId).not.toBe(encounter.meta.versionId);
    expect(view.steps[3]).toMatchObject({
      step: 'update_visit',
      remote: { type: 'Encounter', id: encounter.id, version: updated.meta.versionId },
      deadLetterReason: null,
    });
    expect(view.steps[3]!.attemptLog).toMatchObject([{ attempt: 1, outcome: 'completed', httpStatus: 200 }]);
  });

  it('identifier propagation: each later payload carries the remote identifiers earlier steps got back', async () => {
    const { send, wait } = await boot();
    const visitId = `V-${crypto.randomUUID()}`;

    const location = await send(worldVisitStarted({ visitId }));
    await send(worldPrescriptionWritten(visitId));
    await send(worldDrugDispensed(visitId));
    await send(worldVisitFinished(visitId));
    expect((await wait(location)).status).toBe('completed');

    const [encounter, request, dispense, update] = effects(await mockClient.log({ visitKey: visitId }));
    const encounterId = (encounter!.response.body as { id: string }).id;
    const requestId = (request!.response.body as { id: string }).id;
    expect(request!.request.body).toMatchObject({ encounter: { reference: `Encounter/${encounterId}` } });
    expect(dispense!.request.body).toMatchObject({
      context: { reference: `Encounter/${encounterId}` },
      authorizingPrescription: [{ reference: `MedicationRequest/${requestId}` }],
    });
    expect(update!.method).toBe('PUT');
    expect(update!.path).toBe(`/fhir-r4/v1/Encounter/${encounterId}`);
    expect(update!.request.body).toMatchObject({ resourceType: 'Encounter', id: encounterId });
  });

  it('PUTs the same Encounter, finished, from the pins (not the live mapping), with no diagnosis', async () => {
    const seedA = writeMappingSeed([{ source: WORLD_SOURCE.id, locationCode: WORLD_LOCATIONS[0]!.code, locationId: WORLD_LOCATIONS[0]!.id }], drugs());
    const first = await boot({ MAPPING_SEED_PATH: seedA });
    const visitId = `V-${crypto.randomUUID()}`;
    const location = await first.send(worldVisitStarted({ visitId }));
    await first.wait(location, (v) => v.steps[0]!.state === 'completed');

    // The operator remaps the location while the visit is open: a new hub boot upserts the changed seed.
    const seedB = writeMappingSeed([{ source: WORLD_SOURCE.id, locationCode: WORLD_LOCATIONS[0]!.code, locationId: WORLD_LOCATIONS[1]!.id }], drugs());
    const second = await boot({ MAPPING_SEED_PATH: seedB });
    await second.send(worldPrescriptionWritten(visitId));
    await second.send(worldDrugDispensed(visitId));
    // 09:30:00.900+07:00: sent truncated, in UTC.
    await second.send(worldVisitFinished(visitId, { finishedAt: '2026-03-02T09:30:00.900+07:00' }));
    expect((await second.wait(location)).status).toBe('completed');

    const done = effects(await mockClient.log({ visitKey: visitId }));
    const created = done[0]!.request.body as Record<string, any>;
    const sent = done[3]!.request.body as Record<string, any>;
    expect(sent).toMatchObject({
      resourceType: 'Encounter',
      identifier: [{ system: ENCOUNTER_SYSTEM, value: visitId }],
      status: 'finished',
      class: created.class,
      subject: { reference: `Patient/${worldPatient.ihs}` },
      participant: [{ individual: { reference: `Practitioner/${worldPhysician.ihs}` } }],
      location: [{ location: { reference: `Location/${WORLD_LOCATIONS[0]!.id}` } }],
      period: { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T02:30:00+00:00' },
      statusHistory: [
        { status: 'arrived', period: { start: '2026-03-02T01:00:00+00:00', end: '2026-03-02T02:30:00+00:00' } },
        { status: 'finished', period: { start: '2026-03-02T02:30:00+00:00', end: '2026-03-02T02:30:00+00:00' } },
      ],
      serviceProvider: { reference: `Organization/${world.organization.id}` },
    });
    // Known risk (#9): no diagnosis is sent at close.
    expect(sent).not.toHaveProperty('diagnosis');
  });

  it('events in any order: visit.finished first waits behind the others, and the effects still land in order', async () => {
    const { send, wait } = await boot();
    const visitId = `V-${crypto.randomUUID()}`;

    const location = await send(worldVisitFinished(visitId));
    await send(worldDrugDispensed(visitId));
    await send(worldPrescriptionWritten(visitId));
    await send(worldVisitStarted({ visitId }));
    expect((await wait(location)).status).toBe('completed');

    expect(effects(await mockClient.log({ visitKey: visitId })).map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
      'Encounter created',
      'MedicationRequest created',
      'MedicationDispense created',
      'Encounter updated',
    ]);
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [] });
  });

  it('a PUT applied but answered 500 is not applied again on retry: the retry reads the Encounter and adopts it', async () => {
    const { send, wait } = await boot();
    await mockClient.setFaults({
      seed: 1,
      rules: [{ id: 'put-500-after-apply', match: { method: 'PUT', resourceType: 'Encounter' }, kind: 'http_500_after_apply', firstN: 1 }],
    });
    const visitId = `V-${crypto.randomUUID()}`;

    const location = await send(worldVisitStarted({ visitId }));
    await send(worldPrescriptionWritten(visitId));
    await send(worldDrugDispensed(visitId));
    await send(worldVisitFinished(visitId));
    const view = await wait(location);

    const puts = (await mockClient.log({ visitKey: visitId })).filter((e) => e.kind === 'platform' && e.method === 'PUT');
    expect(puts.map((e) => [e.response.status, e.effect])).toEqual([[500, 'updated']]);
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [] });
    const applied = await mockClient.log({ visitKey: visitId });
    const encounterId = (effects(applied)[0]!.response.body as { id: string }).id;
    expect(view.status).toBe('completed');
    expect(view.steps[3]!.attemptLog).toMatchObject([
      { attempt: 1, outcome: 'retry_wait', httpStatus: 500 },
      { attempt: 2, outcome: 'completed', httpStatus: 200 },
    ]);
    // The adopted version is the one the lost answer carried: the stored record's.
    const read = applied.filter((e) => e.method === 'GET' && e.path === `/fhir-r4/v1/Encounter/${encounterId}`).at(-1)!;
    expect(view.steps[3]!.remote).toEqual({ type: 'Encounter', id: encounterId, version: (read.response.body as any).meta.versionId });
  });
});
