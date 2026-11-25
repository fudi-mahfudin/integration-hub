import { MockClient, type LogEntry } from '@integration-hub/mock-satusehat';
import { startMock, type RunningMock } from '@integration-hub/mock-satusehat/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import { satusehatEnv, WORLD_SOURCE_API_KEY, worldDrugDispensed, worldPrescriptionWritten, worldVisitFinished, worldVisitStarted } from './support/satusehat.js';

const completed = (v: CaseView) => v.status === 'completed';

/** A small seeded PRNG (mulberry32), so a failing shuffle can be replayed from the logged seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const fullVisit = (visitId: string) => [
  worldVisitStarted({ visitId }),
  worldPrescriptionWritten(visitId),
  worldDrugDispensed(visitId),
  worldVisitFinished(visitId),
];

/**
 * Which step a platform request belongs to. Each step reads before it writes:
 * create visit searches and POSTs Encounter, the next two search and POST
 * their resource, update visit GETs and PUTs `/Encounter/{id}`.
 */
function stepOf(e: LogEntry): number | undefined {
  if (e.resourceType === 'MedicationRequest') return 2;
  if (e.resourceType === 'MedicationDispense') return 3;
  if (e.resourceType === 'Encounter') return /\/Encounter\/[^/]+$/.test(e.path) ? 4 : 1;
  return undefined;
}

/** Steps are released strictly in order, one at a time per case (ADR 0004, #34). */
describe('ordering and worker exclusivity', () => {
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

  const env = (extra: Record<string, string> = {}) => ({
    ...satusehatEnv(mock.baseUrl, database.url),
    WORKER_POLL_INTERVAL_MS: '20',
    WORKER_RETRY_DELAY_MS: '50',
    ...extra,
  });
  const startHub = async () => {
    const hub = await bootHub(env());
    running.push(hub);
    return hub;
  };
  const startWorkers = async (n: number, extra: Record<string, string> = {}) => {
    for (let i = 0; i < n; i++) running.push(await bootWorker(env(extra)));
  };
  const send = async (hub: BootedHub, body: unknown) => {
    const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
    expect(res.status, await res.clone().text()).toBe(202);
    return { location: res.headers.get('location') as string, caseStatus: ((await res.json()) as { caseStatus: string }).caseStatus };
  };
  const wait = async (hub: BootedHub, location: string) => {
    const view = await waitForCase(hub.baseUrl, location, completed, { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 20_000 });
    expectAtMostOneStepInMotion(view);
    return view;
  };

  it('events sent shuffled with random delays: steps reach the mock strictly in order; cases wait, then complete', async () => {
    const seed = Date.now() % 1_000_000;
    const rnd = random(seed);
    const hub = await startHub();
    await startWorkers(2);

    const visits = Array.from({ length: 6 }, () => `V-${crypto.randomUUID()}`);
    const sent = await Promise.all(
      visits.map(async (visitId) => {
        let events = shuffle(fullVisit(visitId), rnd);
        // Never lead with visit.started, so the case must wait before it can start.
        if (events[0]!.type === 'visit.started') events = [...events.slice(1), events[0]!];
        const delays = events.map(() => Math.floor(rnd() * 150));
        const answers = [];
        for (const [i, event] of events.entries()) {
          await new Promise((r) => setTimeout(r, delays[i]));
          answers.push(await send(hub, event));
        }
        return { visitId, order: events.map((e) => e.type), answers };
      }),
    );

    for (const { visitId, order, answers } of sent) {
      const why = `seed ${seed}, visit ${visitId}, order ${order.join(' → ')}`;
      expect(answers[0]!.caseStatus, why).toBe('waiting');
      const view = await wait(hub, answers[0]!.location);
      expect(view.steps.map((s) => s.attempts), why).toEqual([1, 1, 1, 1]);

      // No request for a step before the predecessor's effect was answered.
      const log = (await mockClient.log({ visitKey: visitId })).filter((e) => e.kind === 'platform');
      for (let step = 2; step <= 4; step++) {
        const previousEffect = log.find((e) => stepOf(e) === step - 1 && e.effect !== 'none');
        const first = log.filter((e) => stepOf(e) === step).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0];
        expect(previousEffect, why).toBeDefined();
        expect(first, why).toBeDefined();
        expect(Date.parse(first!.receivedAt), `${why}: step ${step} started before step ${step - 1} completed`).toBeGreaterThanOrEqual(
          Date.parse(previousEffect!.respondedAt),
        );
      }
    }
    expect(await mockClient.report()).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [], overlappingInFlight: [] });
  });

  it('N workers with platform latency: no overlapping in-flight requests per visit and no duplicate submission', async () => {
    await mockClient.setFaults({
      seed: 34,
      rules: [{ id: 'slow', match: {}, kind: 'latency', rate: 1, params: { minMs: 5, maxMs: 40 } }],
    });
    const hub = await startHub();
    await startWorkers(4, { WORKER_CONCURRENCY: '4' });

    const visits = Array.from({ length: 10 }, () => `V-${crypto.randomUUID()}`);
    const locations = await Promise.all(
      visits.map(async (visitId) => {
        const [first, ...rest] = fullVisit(visitId).map((e) => send(hub, e));
        await Promise.all(rest);
        return (await first!).location;
      }),
    );
    const views = await Promise.all(locations.map((l) => wait(hub, l)));

    const report = await mockClient.report();
    expect(report).toMatchObject({ duplicateSubmissions: [], outOfOrderEffects: [], overlappingInFlight: [] });
    // The latency really slowed every platform request, so overlaps had their chance.
    const log = (await mockClient.log()).filter((e) => e.kind === 'platform');
    expect(log.every((e) => e.fault === 'slow')).toBe(true);
    const effects = log.filter((e) => e.effect !== 'none');
    expect(effects).toHaveLength(visits.length * 4);
    for (const view of views) expect(view.steps.map((s) => s.state)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });
});
