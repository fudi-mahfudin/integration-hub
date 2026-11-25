import { MockClient, type LogEntry } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import { satusehatEnv, WORLD_SOURCE_API_KEY, worldDrugDispensed, worldPrescriptionWritten, worldVisitFinished, worldVisitStarted } from './support/satusehat.js';
import { spawnWorker, type ChildWorker } from './support/spawn-worker.js';

/** Short enough to keep the suite quick, long enough that no healthy attempt outlives it. */
const LEASE_MS = '2500';
const completed = (v: CaseView) => v.status === 'completed';
const updates = (log: LogEntry[]) => log.filter((e) => e.kind === 'platform' && e.resourceType === 'Encounter' && e.effect === 'updated');

/** Lease recovery and the lease fence (#34, #8): a lost worker's step is recovered with exactly one effect. */
describe('lease recovery', () => {
  let mock: RunningMock;
  let mockClient: MockClient;
  let database: FreshDatabase;
  const running: { close(): Promise<void> }[] = [];
  const children: ChildWorker[] = [];

  beforeAll(async () => {
    mock = await startMock();
    mockClient = new MockClient(mock.baseUrl);
  });

  beforeEach(async () => {
    await mockClient.reset();
    database = await createFreshDatabase();
  });

  afterEach(async () => {
    for (const c of children.splice(0)) {
      c.kill();
      await c.exited;
    }
    // Parked requests would keep a stale worker's attempt (and its close()) waiting.
    await mockClient.reset();
    for (const p of running.splice(0).reverse()) await p.close();
    await database?.drop();
  });

  afterAll(async () => {
    await mock?.close();
  });

  const env = () => ({
    ...satusehatEnv(mock.baseUrl, database.url),
    WORKER_LEASE_MS: LEASE_MS,
    WORKER_CONCURRENCY: '1',
    WORKER_POLL_INTERVAL_MS: '50',
    WORKER_RETRY_DELAY_MS: '50',
  });
  const startHub = async () => {
    const hub = await bootHub(env());
    running.push(hub);
    return hub;
  };
  const sendVisit = async (hub: BootedHub) => {
    const visitId = `V-${crypto.randomUUID()}`;
    const send = async (body: unknown) => {
      const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
      expect(res.status, await res.clone().text()).toBe(202);
      return res.headers.get('location') as string;
    };
    const location = await send(worldVisitStarted({ visitId }));
    await send(worldPrescriptionWritten(visitId));
    await send(worldDrugDispensed(visitId));
    await send(worldVisitFinished(visitId));
    return { visitId, location };
  };
  const wait = async (hub: BootedHub, location: string, done: (v: CaseView) => boolean = completed) => {
    const view = await waitForCase(hub.baseUrl, location, done, { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 20_000 });
    expectAtMostOneStepInMotion(view);
    return view;
  };
  /** Polls the mock's parked requests until `count` are parked. */
  const parked = async (count: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const holds = await mockClient.holds(1_000);
      if (holds.length >= count) return holds;
      if (Date.now() > deadline) throw new Error(`only ${holds.length} of ${count} requests parked`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('SIGKILL while the PUT is parked: another worker process recovers the step after the lease, with exactly one effect', async () => {
    const hub = await startHub();
    await mockClient.setFaults({ seed: 1, rules: [{ id: 'park-put', match: { method: 'PUT' }, kind: 'hold', firstN: 1 }] });
    const doomed = await spawnWorker(env());
    children.push(doomed);
    const { visitId, location } = await sendVisit(hub);

    const held = await mockClient.nextHold(15_000);
    expect(held).toMatchObject({ method: 'PUT', visitKey: visitId });
    doomed.kill();
    await doomed.exited;
    // The platform applies the PUT the dead worker never hears back from.
    await mockClient.releaseHold(held.id);
    const deadline = Date.now() + 5_000;
    while (updates(await mockClient.log({ visitKey: visitId })).length === 0) {
      if (Date.now() > deadline) throw new Error('the released PUT was never applied');
      await new Promise((r) => setTimeout(r, 25));
    }

    const rescuer = await spawnWorker(env());
    children.push(rescuer);
    const done = await wait(hub, location);

    const applied = updates(await mockClient.log({ visitKey: visitId }));
    expect(applied).toHaveLength(1);
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [], overlappingInFlight: [] });
    const update = done.steps[3]!;
    expect(update).toMatchObject({
      state: 'completed',
      attempts: 2,
      remote: { type: 'Encounter', version: (applied[0]!.response.body as { meta: { versionId: string } }).meta.versionId },
    });
    expect(update.attemptLog).toMatchObject([
      { attempt: 1, outcome: 'lease_expired', errorCode: null, httpStatus: null, detail: expect.stringContaining('lease expired') },
      { attempt: 2, outcome: 'completed' },
    ]);
    // The lost attempt ran from its claim until its lease ran out.
    const lost = update.attemptLog[0]!;
    expect(Date.parse(lost.endedAt) - Date.parse(lost.startedAt)).toBe(Number(LEASE_MS));
    for (const step of done.steps.slice(0, 3)) expect(step.attempts).toBe(1);
  });

  it('a stale worker finishing while the new holder is in flight: its completion is discarded by the fence', async () => {
    const hub = await startHub();
    // Park update visit's read (GET /Encounter/{id}) for the first two attempts; searches and the PUT pass.
    await mockClient.setFaults({
      seed: 1,
      rules: [{ id: 'park-read', match: { method: 'GET', path: '/fhir-r4/v1/Encounter/*' }, kind: 'hold', firstN: 2 }],
    });
    const stale = await bootWorker(env());
    running.push(stale);
    const { location } = await sendVisit(hub);
    const [staleRead] = await parked(1);

    // The stale worker's only slot is parked; a second worker reclaims the step once the lease expires.
    running.push(await bootWorker(env()));
    const holds = await parked(2);
    const newRead = holds.find((h) => h.id !== staleRead!.id)!;
    const inFlight = await wait(hub, location, (v) => v.steps[3]!.attempts === 2);
    expect(inFlight.steps[3]).toMatchObject({ state: 'in_flight', remote: null });
    expect(inFlight.steps[3]!.attemptLog).toMatchObject([{ attempt: 1, outcome: 'lease_expired', errorCode: null, httpStatus: null }]);

    // The stale worker carries on: it reads, PUTs (the one effect) and tries to complete. close() waits for it.
    await mockClient.releaseHold(staleRead!.id);
    await stale.close();
    const discarded = await wait(hub, location, () => true);
    expect(discarded.status).toBe('active');
    expect(discarded.steps[3]).toMatchObject({ state: 'in_flight', attempts: 2, remote: null });
    expect(discarded.steps[3]!.attemptLog).toEqual(inFlight.steps[3]!.attemptLog);

    // The new holder reads the applied PUT and adopts it.
    await mockClient.releaseHold(newRead.id);
    const done = await wait(hub, location);
    const [applied, ...more] = updates(await mockClient.log());
    expect(more).toEqual([]);
    expect(done.steps[3]).toMatchObject({
      state: 'completed',
      attempts: 2,
      remote: { type: 'Encounter', version: (applied!.response.body as { meta: { versionId: string } }).meta.versionId },
    });
    expect(done.steps[3]!.attemptLog.map((a) => [a.attempt, a.outcome])).toEqual([
      [1, 'lease_expired'],
      [2, 'completed'],
    ]);
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [] });
  });
});

