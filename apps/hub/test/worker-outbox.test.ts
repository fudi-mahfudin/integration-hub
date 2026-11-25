import { MockClient } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import {
  satusehatEnv,
  WORLD_LOCATIONS,
  WORLD_SOURCE,
  WORLD_SOURCE_API_KEY,
  worldVisitStarted,
  writeMappingSeed,
} from './support/satusehat.js';

const createVisitDone = (v: CaseView) => v.steps[0]?.state === 'completed';

describe('worker and outbox', () => {
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

  const start = async <T extends { close(): Promise<void> }>(p: Promise<T>): Promise<T> => {
    const booted = await p;
    running.push(booted);
    return booted;
  };
  const send = (hub: BootedHub, body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
  const waitFor = (hub: BootedHub, res: Response, done: (v: CaseView) => boolean) =>
    waitForCase(hub.baseUrl, res.headers.get('location') as string, done, { apiKey: WORLD_SOURCE_API_KEY });

  it('loads the location seed idempotently at every boot; a changed entry takes effect', async () => {
    const code = 'SEEDED-LOC';
    const seed = (locationId: string) => writeMappingSeed([{ source: WORLD_SOURCE.id, locationCode: code, locationId }]);
    const first = seed(WORLD_LOCATIONS[0]!.id);
    const changed = seed(WORLD_LOCATIONS[1]!.id);

    // Same file twice, then a changed file twice: every boot succeeds.
    for (const path of [first, first, changed]) {
      await (await bootHub(satusehatEnv(mock.baseUrl, database.url, path))).close();
    }
    const env = satusehatEnv(mock.baseUrl, database.url, changed);
    const hub = await start(bootHub(env));
    await start(bootWorker(env));

    const event = worldVisitStarted({ data: { locationCode: code } });
    await waitFor(hub, await send(hub, event), createVisitDone);

    const [post] = (await mockClient.log({ visitKey: event.visitId, resourceType: 'Encounter' })).filter(
      (e) => e.method === 'POST',
    );
    expect(post?.request.body).toMatchObject({ location: [{ location: { reference: `Location/${WORLD_LOCATIONS[1]!.id}` } }] });
  });

  it('two workers claim with skip-locked row locks: every visit gets exactly one Encounter', async () => {
    const env = satusehatEnv(mock.baseUrl, database.url);
    const hub = await start(bootHub(env));
    await start(bootWorker(env));
    await start(bootWorker(env));

    const events = Array.from({ length: 12 }, () => worldVisitStarted());
    const accepted = await Promise.all(events.map((e) => send(hub, e)));
    const views = await Promise.all(accepted.map((res) => waitFor(hub, res, createVisitDone)));

    const created = (await mockClient.log({ resourceType: 'Encounter' })).filter((e) => e.effect === 'created');
    expect(created.map((e) => e.visitKey).sort()).toEqual(events.map((e) => e.visitId).sort());
    expect((await mockClient.report()).duplicateSubmissions).toEqual([]);
    for (const view of views) {
      expect(view.steps[0]?.attempts).toBe(1);
      expectAtMostOneStepInMotion(view);
    }
  });

  it('counts an attempt on every claim; a transient failure makes the step claimable again', async () => {
    // A wrong client secret fails every token request: a transient failure on each attempt.
    const env = { ...satusehatEnv(mock.baseUrl, database.url), SATUSEHAT_CLIENT_SECRET: 'wrong', WORKER_RETRY_DELAY_MS: '10' };
    const hub = await start(bootHub(env));
    await start(bootWorker(env));

    const view = await waitFor(hub, await send(hub, worldVisitStarted()), (v) => (v.steps[0]?.attempts ?? 0) >= 3);

    expect(view.status).toBe('active');
    expect(['ready', 'in_flight', 'retry_wait']).toContain(view.steps[0]?.state);
    expect(view.steps[0]?.remote).toBeNull();
    expectAtMostOneStepInMotion(view);
  });
  it('a platform 4xx with an OperationOutcome is permanent: the step dead-letters at once, no retry', async () => {
    // The validator rejects the Encounter create (400 OperationOutcome).
    await mockClient.setFaults({
      seed: 1,
      rules: [{ id: 'reject-create', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_400', rate: 1 }],
    });
    const env = { ...satusehatEnv(mock.baseUrl, database.url), WORKER_RETRY_DELAY_MS: '10' };
    const hub = await start(bootHub(env));
    await start(bootWorker(env));

    const view = await waitFor(hub, await send(hub, worldVisitStarted()), (v) => v.status !== 'active');

    expect(view.status).toBe('dead_lettered');
    expect(view.steps[0]).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PAYLOAD_INVALID', attempts: 1, remote: null });
    expect(view.steps[0]?.attemptLog).toMatchObject([{ attempt: 1, outcome: 'dead_lettered', errorCode: 'PAYLOAD_INVALID', httpStatus: 400 }]);
    expect((await mockClient.log({ resourceType: 'Encounter' })).filter((e) => e.method === 'POST')).toHaveLength(1);
    expectAtMostOneStepInMotion(view);
  });

  for (const kind of ['http_401', 'http_429', 'http_500'] as const) {
    it(`a platform ${kind.slice(5)} stays transient: the step is retried`, async () => {
      await mockClient.setFaults({
        seed: 1,
        rules: [{ id: 'fail-create', match: { method: 'POST', resourceType: 'Encounter' }, kind, firstN: 2 }],
      });
      const env = { ...satusehatEnv(mock.baseUrl, database.url), WORKER_RETRY_DELAY_MS: '10' };
      const hub = await start(bootHub(env));
      await start(bootWorker(env));

      const view = await waitFor(hub, await send(hub, worldVisitStarted()), createVisitDone);

      expect(view.steps[0]?.deadLetterReason).toBeNull();
      expect(view.steps[0]?.attemptLog.map((a) => a.outcome)).toContain('retry_wait');
      expectAtMostOneStepInMotion(view);
    });
  }
});
