import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { adminRequest, postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { awaitRun, listRuns, readRun, requestRun } from './support/reconciliation.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitEvents, type BootedMock } from './support/satusehat.js';
import { spawnWorker } from './support/spawn-worker.js';

/** A fresh mock and database, and the world's environment over them with `env` on top. */
function freshWorld(env: Record<string, string> = {}) {
  const booted: { mock?: BootedMock; database?: FreshDatabase } = {};
  beforeAll(async () => {
    booted.mock = await bootMock();
    booted.database = await createFreshDatabase();
  });
  afterAll(async () => {
    await booted.database?.drop();
    await booted.mock?.close();
  });
  return () => {
    if (!booted.mock || !booted.database) throw new Error('the world is not booted');
    return { mock: booted.mock, env: { ...worldEnv(booted.mock.baseUrl, booted.database.url), ...env } };
  };
}

/** Delivers a whole world visit through `hub`; resolves to its completed case. */
async function completedCase(hub: BootedHub) {
  let location: string | null = null;
  for (const event of worldVisitEvents().events) {
    location = (await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: event })).headers.get('location');
  }
  return waitForCase(hub.baseUrl, location, (v) => v.status === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });
}

describe('scheduled reconciliation (#39)', () => {
  const world = freshWorld({ RECONCILIATION_INTERVAL_MS: '300', RECONCILIATION_LOOKBACK_MS: '1500' });
  let hub: BootedHub;
  let worker: BootedWorker;
  beforeAll(async () => {
    hub = await bootHub(world().env);
    worker = await bootWorker(world().env);
  });
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
  });

  it('a run is scheduled once the last started longer ago than the interval; it covers the cases changed within the lookback', async () => {
    const kase = await completedCase(hub);

    // A scheduled run that started after the case completed covers it.
    let covering: Awaited<ReturnType<typeof listRuns>>[number] | undefined;
    const deadline = Date.now() + 10_000;
    while (!covering && Date.now() < deadline) {
      covering = (await listRuns(hub.baseUrl, 5)).find((r) => r.trigger === 'schedule' && r.counts.cases === 1 && r.status === 'completed');
      if (!covering) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(covering).toMatchObject({ counts: { cases: 1, clean: 1 }, scope: { caseIds: null, since: null } });
    const view = await waitForCase(hub.baseUrl, `/v1/cases/${kase.caseId}`, () => true, { apiKey: WORLD_SOURCE_API_KEY });
    expect(view.divergences).toEqual([]);

    // Runs keep to the interval: each started at least 300ms after the one before.
    const scheduled = (await listRuns(hub.baseUrl, 100)).filter((r) => r.trigger === 'schedule');
    const starts = scheduled.map((r) => Date.parse(r.startedAt ?? '')).sort((a, b) => a - b);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < starts.length; i++) expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(300);

    // Once its last change is older than the lookback, the case is out of scope.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const later = Date.now();
    let outOfScope: Awaited<ReturnType<typeof listRuns>>[number] | undefined;
    while (!outOfScope && Date.now() < later + 5_000) {
      outOfScope = (await listRuns(hub.baseUrl, 5)).find((r) => r.status === 'completed' && Date.parse(r.startedAt ?? '') > later);
      if (!outOfScope) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(outOfScope?.counts.cases).toBe(0);
  });
});

describe('a run left running without the lock (#39)', () => {
  const world = freshWorld();
  let hub: BootedHub;
  let worker: BootedWorker | undefined;
  beforeAll(async () => {
    hub = await bootHub(world().env);
  });
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
  });

  it('is marked failed by the next worker that takes the lock, and the next run goes ahead', async () => {
    const { mock, env } = world();
    const crashing = await spawnWorker(env);
    const kase = await completedCase(hub);
    await mock.client.setFaults({ seed: 39, rules: [{ id: 'park-search', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 1, kind: 'hold' }] });
    const orphaned = await requestRun(hub.baseUrl, { caseIds: [kase.caseId] });
    await mock.client.holds(10_000);
    await crashing.crash();
    await mock.client.setFaults({ seed: 39, rules: [] });

    // Nothing holds the lock now, but the run still reads as running.
    expect(await readRun(hub.baseUrl, orphaned)).toMatchObject({ status: 'running' });
    const blocked = await adminRequest(hub.baseUrl, 'POST', 'v1/admin/reconciliation/runs', { body: {} });
    expect(await blocked.json()).toMatchObject({ code: 'RECONCILIATION_RUNNING', runId: orphaned });

    worker = await bootWorker(env);
    expect(await awaitRun(hub.baseUrl, orphaned)).toMatchObject({ status: 'failed', error: expect.stringContaining('without the lock'), endedAt: expect.any(String) });
    const next = await awaitRun(hub.baseUrl, await requestRun(hub.baseUrl, { caseIds: [kase.caseId] }));
    expect(next).toMatchObject({ status: 'completed', counts: { cases: 1, clean: 1 } });
  });
});

describe('reconciliation retention (#39)', () => {
  const world = freshWorld();
  const DAY_MS = 24 * 60 * 60 * 1000;
  let offsetMs = 0;
  let hub: BootedHub;
  let worker: BootedWorker;
  beforeAll(async () => {
    hub = await bootHub(world().env, () => new Date(Date.now() + offsetMs));
    worker = await bootWorker(world().env);
  });
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
  });

  /** Requests a run as of `daysAgo` days ago and waits for it to end. */
  async function runRequested(daysAgo: number): Promise<string> {
    offsetMs = -daysAgo * DAY_MS;
    const runId = await requestRun(hub.baseUrl, {});
    await awaitRun(hub.baseUrl, runId);
    return runId;
  }

  it('runs older than 14 days are deleted with their findings when a new run is created; the latest completed run is kept', async () => {
    const oldest = await runRequested(20);
    const latestCompleted = await runRequested(16);
    const recent = await runRequested(13);
    expect(await listRuns(hub.baseUrl, 10)).toHaveLength(3);

    // `recent` is now the latest completed run, so both old ones go.
    offsetMs = 0;
    const created = await requestRun(hub.baseUrl, {});

    expect((await adminRequest(hub.baseUrl, 'GET', `v1/admin/reconciliation/runs/${oldest}`)).status).toBe(404);
    expect((await adminRequest(hub.baseUrl, 'GET', `v1/admin/reconciliation/runs/${latestCompleted}`)).status).toBe(404);
    expect((await listRuns(hub.baseUrl, 10)).map((r) => r.runId)).toEqual([created, recent]);
    await awaitRun(hub.baseUrl, created);
  });

  it('keeps the latest completed run however old it is', async () => {
    const old = await runRequested(30);
    // A month on, every run is older than 14 days; `old` ended last, so it is the latest completed run.
    offsetMs = 30 * DAY_MS;
    const created = await requestRun(hub.baseUrl, {});

    const kept = (await listRuns(hub.baseUrl, 10)).map((r) => r.runId);
    expect(kept).toEqual([created, old]);
    await awaitRun(hub.baseUrl, created);
  });
});
