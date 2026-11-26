import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { getCase, postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  type BootedMock,
  bootMock,
  WORLD_SOURCE_API_KEY,
  worldEnv,
  worldVisitEvents,
  worldVisitStarted,
} from './support/satusehat.js';
import { spawnWorker, type SpawnedWorker } from './support/spawn-worker.js';

/** Short enough that the test waits about a second for it; long enough that a live attempt never outlives it here. */
const LEASE_MS = 1_500;

describe('lease recovery: a crashed worker’s step is taken over and causes one effect', () => {
  let mock: BootedMock | undefined;
  let database: FreshDatabase | undefined;
  let hub: BootedHub | undefined;
  const workers: SpawnedWorker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  it('a worker SIGKILLed while the mock holds its create is replaced; the case completes with each record created once', async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), WORKER_LEASE_MS: String(LEASE_MS) };
    hub = await bootHub(env);
    await mock.client.setFaults({
      seed: 34,
      rules: [{ id: 'park-first-create', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }],
    });
    const crashing = await spawnWorker(env);
    workers.push(crashing);

    const { visit, events } = worldVisitEvents();
    let location: string | null = null;
    for (const body of events) {
      location = (await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body })).headers.get('location');
    }

    const [hold] = await mock.client.holds(10_000);
    expect(hold).toMatchObject({ method: 'POST', resourceType: 'Encounter', visitKey: visit.visitId });
    await crashing.crash();
    // The crashed worker's create reached the platform: it is applied though no one is left to read the answer.
    await mock.client.releaseHold(hold?.id ?? '');
    const replacement = await spawnWorker(env);
    workers.push(replacement);

    const view = await waitForCase(hub.baseUrl, location, (v) => v.status === 'completed', {
      apiKey: WORLD_SOURCE_API_KEY,
      timeoutMs: 15_000,
    });

    const effects = (await mock.client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
      'Encounter created',
      'MedicationRequest created',
      'MedicationDispense created',
      'Encounter updated',
    ]);
    expect(await mock.client.report()).toEqual({ faultSeed: 34, duplicates: [], outOfOrder: [], overlap: [] });
    const created = effects[0]?.response.body;
    expect(view.steps[0]).toMatchObject({
      state: 'completed',
      attempts: 2,
      remote: { type: 'Encounter', id: typeof created === 'object' && created !== null && 'id' in created ? created.id : 'missing' },
    });
    expectAtMostOneStepInMotion(view);
  }, 30_000);

  it('an attempt whose lease ran out is logged as lease_expired, ending when its lease did', async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), WORKER_LEASE_MS: String(LEASE_MS) };
    hub = await bootHub(env);
    await mock.client.setFaults({
      seed: 34,
      rules: [{ id: 'park-first-create', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }],
    });
    const crashing = await spawnWorker(env);
    workers.push(crashing);

    const accepted = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted() });
    const [hold] = await mock.client.holds(10_000);
    await crashing.crash();
    await mock.client.releaseHold(hold?.id ?? '');
    workers.push(await spawnWorker(env));

    const view = await waitForCase(hub.baseUrl, accepted.headers.get('location'), (v) => v.steps[0]?.state === 'completed', {
      apiKey: WORLD_SOURCE_API_KEY,
      timeoutMs: 15_000,
    });

    const [expired, completed] = view.steps[0]?.attemptLog ?? [];
    expect(view.steps[0]?.attemptLog).toHaveLength(2);
    expect(expired).toMatchObject({ attempt: 1, outcome: 'lease_expired', errorCode: null, httpStatus: null });
    expect(completed).toMatchObject({ attempt: 2, outcome: 'completed' });
    // The expired attempt ended when its lease ran out, a lease's length after it started.
    expect(Date.parse(expired?.endedAt ?? '') - Date.parse(expired?.startedAt ?? '')).toBe(LEASE_MS);
    expect(Date.parse(completed?.startedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(expired?.endedAt ?? ''));
  }, 30_000);
  it('a stale worker’s late completion is discarded by the lease fence and changes nothing', async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), WORKER_LEASE_MS: String(LEASE_MS) };
    hub = await bootHub(env);
    await mock.client.setFaults({
      seed: 34,
      rules: [{ id: 'park-first-search', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }],
    });
    const stale = await spawnWorker(env);
    workers.push(stale);

    const { visit, events } = worldVisitEvents();
    const accepted = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: visit });
    const location = accepted.headers.get('location');
    const [hold] = await mock.client.holds(10_000);
    expect(hold).toMatchObject({ method: 'GET', resourceType: 'Encounter', visitKey: visit.visitId });
    // The stale worker stays alive, parked in its search-then-create, while its lease runs out and another takes over.
    workers.push(await spawnWorker(env));
    for (const body of events.slice(1)) {
      await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
    }
    const completed = await waitForCase(hub.baseUrl, location, (v) => v.status === 'completed', {
      apiKey: WORLD_SOURCE_API_KEY,
      timeoutMs: 15_000,
    });

    // Released, the stale search finds the Encounter the new holder created, and the stale attempt completes late.
    await mock.client.releaseHold(hold?.id ?? '');
    const caseId = completed.caseId;
    const discarded = await eventually(() =>
      stale.logged().find((line) => line.caseId === caseId && line.message === 'the lease was lost before the outcome was stored; the outcome is discarded'),
    );

    expect(discarded).toMatchObject({ level: 'warn', step: 'create_visit', attempt: 1 });
    expect(await (await getCase(hub.baseUrl, caseId, WORLD_SOURCE_API_KEY)).json()).toEqual(completed);
    expect(completed.steps[0]?.attemptLog.map((a) => `${a.attempt} ${a.outcome}`)).toEqual(['1 lease_expired', '2 completed']);
    const searches = await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' });
    const parked = searches.find((e) => e.fault === 'park-first-search');
    expect(parked?.response.status).toBe(200);
    const effects = searches.filter((e) => e.effect !== 'none');
    expect(effects.map((e) => e.effect)).toEqual(['created', 'updated']);
    const report = await mock.client.report();
    expect(report).toMatchObject({ duplicates: [], outOfOrder: [] });
    // The stale worker's parked search was in flight through the new holder's work: that, and nothing else, overlaps.
    expect(report.overlap.length).toBeGreaterThan(0);
    expect(report.overlap.filter((o) => !o.seqs.includes(parked?.seq ?? -1))).toEqual([]);
  }, 30_000);
});

/** Polls `find` every 20ms until it returns something, and resolves to that. Fails after 5s. */
async function eventually<T>(find: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = find();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('nothing was found within 5s');
}
