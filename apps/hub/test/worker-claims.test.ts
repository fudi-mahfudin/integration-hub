import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
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

const createVisitCompleted = (v: CaseView) => v.steps[0]?.state === 'completed';

describe('workers claiming from the outbox', () => {
  let mock: BootedMock | undefined;
  let database: FreshDatabase | undefined;
  let hub: BootedHub | undefined;
  let workers: BootedWorker[] = [];

  /** A mock, a fresh database, a hub and `workerCount` worker processes, all wired together. */
  async function bootStack(workerCount: number): Promise<{ mock: BootedMock; hub: BootedHub }> {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    workers = await Promise.all(Array.from({ length: workerCount }, () => bootWorker(env)));
    return { mock, hub };
  }

  afterEach(async () => {
    await Promise.all(workers.map((w) => w.close()));
    workers = [];
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  it('a worker fetches one client_credentials token and reuses it for every call', async () => {
    const stack = await bootStack(1);

    for (const event of [worldVisitStarted(), worldVisitStarted()]) {
      const res = await postEvent(stack.hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: event });
      await waitForCase(stack.hub.baseUrl, res.headers.get('location'), createVisitCompleted, { apiKey: WORLD_SOURCE_API_KEY });
    }

    const entries = await stack.mock.client.log();
    const tokenRequests = entries.filter((e) => e.path.startsWith('/oauth2/v1/accesstoken'));
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.response.status).toBe(200);
    // Each visit searches for its Encounter and its patient; only the first searches for the practitioner, whom the second finds in the IHS-number cache (#47).
    expect(entries.filter((e) => e.path.startsWith('/fhir-r4/') && e.response.status === 200).length).toBeGreaterThanOrEqual(5);
  });

  it('concurrent workers carry out each step once: one claim and one Encounter per visit', async () => {
    const stack = await bootStack(4);
    const events = Array.from({ length: 16 }, () => worldVisitStarted());

    const accepted = await Promise.all(
      events.map((body) => postEvent(stack.hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body })),
    );
    const views = await Promise.all(
      accepted.map((res) =>
        waitForCase(stack.hub.baseUrl, res.headers.get('location'), createVisitCompleted, {
          apiKey: WORLD_SOURCE_API_KEY,
          timeoutMs: 10_000,
        }),
      ),
    );

    for (const view of views) {
      expect(view.steps[0]).toMatchObject({ state: 'completed', attempts: 1 });
      expectAtMostOneStepInMotion(view);
    }
    const report = await stack.mock.client.report();
    expect(report.duplicates).toEqual([]);
    const posts = (await stack.mock.client.log({ resourceType: 'Encounter' })).filter((e) => e.method === 'POST');
    expect(posts.map((e) => e.visitKey).sort()).toEqual(events.map((e) => e.visitId).sort());
  });

  it('slow responses never let two workers work one case at once: no overlapping requests per visit, no duplicate submission', async () => {
    const stack = await bootStack(4);
    await stack.mock.client.setFaults({
      seed: 34,
      rules: [{ id: 'slow-platform', match: {}, rate: 1, kind: 'latency', params: { minMs: 10, maxMs: 60 } }],
    });
    const views = await Promise.all(
      Array.from({ length: 8 }, async () => {
        let location: string | null = null;
        for (const body of worldVisitEvents().events) {
          location = (await postEvent(stack.hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body })).headers.get('location');
        }
        return waitForCase(stack.hub.baseUrl, location, (v) => ['completed', 'dead_lettered'].includes(v.status), {
          apiKey: WORLD_SOURCE_API_KEY,
          timeoutMs: 30_000,
        });
      }),
    );

    expect(await stack.mock.client.report()).toEqual({ faultSeed: 34, duplicates: [], outOfOrder: [], overlap: [] });
    for (const view of views) {
      expect(view.status).toBe('completed');
      expect(view.steps.map((s) => s.attempts)).toEqual([1, 1, 1, 1]);
    }
    // Every request was slowed: the workers had every chance to collide.
    const entries = await stack.mock.client.log();
    expect(entries.filter((e) => e.fault === 'slow-platform').length).toBe(entries.length);
  }, 45_000);
});
