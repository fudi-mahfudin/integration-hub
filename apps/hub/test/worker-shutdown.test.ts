import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { getCase, caseViewSchema, postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { awaitRun, readRun, requestRun } from './support/reconciliation.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitEvents, worldVisitStarted, type BootedMock } from './support/satusehat.js';
import { spawnWorker, type SpawnedWorker } from './support/spawn-worker.js';

/** Short, so the deadline tests wait about a second for it. */
const DRAIN_DEADLINE_MS = 1_000;

describe('worker graceful shutdown (#43)', () => {
  let mock: BootedMock | undefined;
  let database: FreshDatabase | undefined;
  let hub: BootedHub | undefined;
  const spawned: SpawnedWorker[] = [];
  let replacement: BootedWorker | undefined;

  afterEach(async () => {
    await Promise.all(spawned.splice(0).map((w) => w.crash()));
    await replacement?.close();
    replacement = undefined;
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  /** A mock, a fresh database and a hub over them; resolves to the world's environment with `env` on top. */
  async function world(env: Record<string, string> = {}): Promise<Record<string, string>> {
    mock = await bootMock();
    database = await createFreshDatabase();
    const worldWithEnv = { ...worldEnv(mock.baseUrl, database.url), ...env };
    hub = await bootHub(worldWithEnv);
    return worldWithEnv;
  }

  async function spawn(env: Record<string, string>): Promise<SpawnedWorker> {
    const worker = await spawnWorker(env);
    spawned.push(worker);
    return worker;
  }

  async function caseAt(location: string | null): Promise<CaseView> {
    const caseId = location?.split('/').at(-1) ?? '';
    return caseViewSchema.parse(await (await getCase(hubOf().baseUrl, caseId, WORLD_SOURCE_API_KEY)).json());
  }

  const hubOf = () => {
    if (!hub) throw new Error('the hub is not booted');
    return hub;
  };
  const mockOf = () => {
    if (!mock) throw new Error('the mock is not booted');
    return mock;
  };

  it('normal drain: the attempt in flight finishes, nothing new is claimed, and the process exits 0 with one effect', async () => {
    const env = await world();
    await mockOf().client.setFaults({ seed: 43, rules: [{ id: 'park-create', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    const worker = await spawn(env);
    const a = worldVisitStarted();
    const aLocation = (await postEvent(hubOf().baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: a })).headers.get('location');
    const [hold] = await mockOf().client.holds(10_000);
    const bLocation = (await postEvent(hubOf().baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted() })).headers.get('location');

    worker.signal('SIGTERM');
    const draining = await fetch(new URL('readyz', worker.baseUrl));
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ status: 'draining' });
    // Long enough for an idle worker to have claimed B many times over (it polls every 20ms).
    await new Promise((resolve) => setTimeout(resolve, 300));
    await mockOf().client.releaseHold(hold?.id ?? '');

    expect(await worker.exited()).toBe(0);
    const caseA = await caseAt(aLocation);
    expect(caseA.steps[0]).toMatchObject({ state: 'completed', attempts: 1 });
    expect(caseA.steps[0]?.attemptLog.map((l) => l.outcome)).toEqual(['completed']);
    expect((await caseAt(bLocation)).steps[0]).toMatchObject({ state: 'ready', attempts: 0 });
    const effects = (await mockOf().client.log({ visitKey: a.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created']);
  }, 30_000);

  it('deadline exceeded: the attempt is released as worker_shutdown, claimable at once, and another worker completes it with one effect', async () => {
    const env = await world({ WORKER_DRAIN_DEADLINE_MS: String(DRAIN_DEADLINE_MS) });
    await mockOf().client.setFaults({ seed: 43, rules: [{ id: 'park-search', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    const worker = await spawn(env);
    const visit = worldVisitStarted();
    const location = (await postEvent(hubOf().baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: visit })).headers.get('location');
    await mockOf().client.holds(10_000);

    worker.signal('SIGTERM');

    expect(await worker.exited()).toBe(0);
    const released = await caseAt(location);
    const [shutdown] = released.steps[0]?.attemptLog ?? [];
    expect(released.steps[0]).toMatchObject({ state: 'retry_wait', attempts: 1 });
    expect(shutdown).toMatchObject({ attempt: 1, outcome: 'worker_shutdown', errorCode: null });
    // Claimable at once: no backoff, and no wait for the lease (90s by default) to expire.
    expect(released.steps[0]?.availableAt).toBe(shutdown?.endedAt);

    replacement = await bootWorker(env);
    const completed = await waitForCase(hubOf().baseUrl, location, (v) => v.steps[0]?.state === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });
    expect(completed.steps[0]?.attemptLog.map((l) => `${l.attempt} ${l.outcome}`)).toEqual(['1 worker_shutdown', '2 completed']);
    const effects = (await mockOf().client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created']);
  }, 30_000);

  it('deadline exceeded after the write was applied (apply-then-fail): the next worker adopts the record, one effect', async () => {
    const env = await world({ WORKER_DRAIN_DEADLINE_MS: String(DRAIN_DEADLINE_MS) });
    await mockOf().client.setFaults({ seed: 43, rules: [{ id: 'park-create', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    const worker = await spawn(env);
    const visit = worldVisitStarted();
    const location = (await postEvent(hubOf().baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: visit })).headers.get('location');
    const [hold] = await mockOf().client.holds(10_000);

    worker.signal('SIGTERM');
    expect(await worker.exited()).toBe(0);
    // The aborted create had reached the platform: released now, it is applied with no one left to read the answer.
    await mockOf().client.releaseHold(hold?.id ?? '');
    replacement = await bootWorker(env);

    const completed = await waitForCase(hubOf().baseUrl, location, (v) => v.steps[0]?.state === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });
    expect(completed.steps[0]?.attemptLog.map((l) => `${l.attempt} ${l.outcome}`)).toEqual(['1 worker_shutdown', '2 completed']);
    const effects = (await mockOf().client.log({ visitKey: visit.visitId })).filter((e) => e.effect !== 'none');
    expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual(['Encounter created']);
    expect((await mockOf().client.report()).duplicates).toEqual([]);
  }, 30_000);

  it('a second signal skips the rest of the drain: the attempt is released as worker_shutdown at once', async () => {
    // The default 70s drain deadline: only the second signal can end the drain within the test.
    const env = await world();
    await mockOf().client.setFaults({ seed: 43, rules: [{ id: 'park-search', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    const worker = await spawn(env);
    const location = (await postEvent(hubOf().baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted() })).headers.get('location');
    await mockOf().client.holds(10_000);

    worker.signal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.signal('SIGINT');

    expect(await worker.exited()).toBe(0);
    expect((await caseAt(location)).steps[0]?.attemptLog.map((l) => l.outcome)).toEqual(['worker_shutdown']);
  }, 30_000);

  it('a reconciliation run in progress, with no step lease held, is interrupted at once, its lock released, and never resumed', async () => {
    const env = await world();
    replacement = await bootWorker(env);
    let location: string | null = null;
    for (const event of worldVisitEvents().events) location = (await postEvent(hubOf().baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: event })).headers.get('location');
    const kase = await waitForCase(hubOf().baseUrl, location, (v) => v.status === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });
    await replacement.close();
    replacement = undefined;
    await mockOf().client.setFaults({ seed: 43, rules: [{ id: 'park-search', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    const worker = await spawn(env);
    const runId = await requestRun(hubOf().baseUrl, { caseIds: [kase.caseId] });
    await mockOf().client.holds(10_000);

    worker.signal('SIGTERM');

    expect(await worker.exited()).toBe(0);
    expect(await readRun(hubOf().baseUrl, runId)).toMatchObject({ status: 'interrupted', endedAt: expect.any(String) });
    await mockOf().client.setFaults({ seed: 43, rules: [] });
    replacement = await bootWorker(env);
    const next = await awaitRun(hubOf().baseUrl, await requestRun(hubOf().baseUrl, { caseIds: [kase.caseId] }));
    expect(next).toMatchObject({ status: 'completed', counts: { cases: 1, clean: 1 } });
    expect(await readRun(hubOf().baseUrl, runId)).toMatchObject({ status: 'interrupted' });
  }, 30_000);
});
