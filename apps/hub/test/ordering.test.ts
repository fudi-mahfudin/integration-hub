import type { LogEntry } from '@integration-hub/mock-satusehat/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
} from './support/satusehat.js';

const VISITS = 6;
const WORKERS = 3;
const MAX_DELAY_MS = 150;

describe('ordering: a visit’s steps are released strictly in order, whatever order its events arrive in', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let workers: BootedWorker[] = [];

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    workers = await Promise.all(Array.from({ length: WORKERS }, () => bootWorker(env)));
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const send = (body: unknown) => postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body });
  const waitOptions = { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 15_000 };

  /** Sends one visit's four events shuffled, with random delays, and resolves to its visit id and completed case. */
  async function sendShuffled(seed: number): Promise<{ visitId: string; view: CaseView }> {
    const random = seededRandom(seed);
    const { visit, events: inOrder } = worldVisitEvents();
    const events = shuffle(inOrder, random);
    const last = events.pop();
    if (!last) throw new Error('a visit has four events');

    let location: string | null = null;
    for (const event of events) {
      await delay(Math.floor(random() * MAX_DELAY_MS));
      location = (await send(event)).headers.get('location');
    }
    // With one event missing, every step before it completes and the case then waits for it.
    const waiting = await waitForCase(hub.baseUrl, location, (v) => v.status === 'waiting' && v.waitingFor === last.type, waitOptions);
    expectAtMostOneStepInMotion(waiting);
    await delay(Math.floor(random() * MAX_DELAY_MS));
    await send(last);
    const view = await waitForCase(hub.baseUrl, location, (v) => ['completed', 'dead_lettered'].includes(v.status), waitOptions);
    return { visitId: visit.visitId, view };
  }

  it('shuffled, delayed events: each case waits, then completes, and SATUSEHAT sees every step only after its predecessor completed', async () => {
    const visits = await Promise.all(Array.from({ length: VISITS }, (_, i) => sendShuffled(34 + i)));

    expect(await mock.client.report()).toEqual({ faultSeed: null, duplicates: [], outOfOrder: [], overlap: [] });
    for (const { visitId, view } of visits) {
      expect(view.status).toBe('completed');
      expectAtMostOneStepInMotion(view);
      const completedAt = view.steps.map((s) => {
        const done = s.attemptLog.find((a) => a.outcome === 'completed');
        if (!done) throw new Error(`step ${s.step} of ${visitId} has no completed attempt`);
        return Date.parse(done.endedAt);
      });
      for (const [i, step] of view.steps.entries()) {
        const predecessorDone = completedAt[i - 1];
        if (predecessorDone === undefined) continue;
        for (const a of step.attemptLog) expect(Date.parse(a.startedAt)).toBeGreaterThanOrEqual(predecessorDone);
      }

      const entries = await mock.client.log({ visitKey: visitId });
      expect(entries.filter((e) => e.effect !== 'none').map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
        'Encounter created',
        'MedicationRequest created',
        'MedicationDispense created',
        'Encounter updated',
      ]);
      for (const entry of entries) {
        const predecessorDone = completedAt[stepOf(entry) - 1];
        if (predecessorDone === undefined) continue;
        expect(Date.parse(entry.receivedAt), `${entry.method} ${entry.path} of ${visitId}`).toBeGreaterThanOrEqual(predecessorDone);
      }
    }
  }, 60_000);
});

/** Which step (0-3) sent a request the mock filed under a visit. */
function stepOf(entry: LogEntry): number {
  if (entry.resourceType === 'MedicationRequest') return 1;
  if (entry.resourceType === 'MedicationDispense') return 2;
  if (entry.resourceType === 'Encounter' && entry.method === 'PUT') return 3;
  return 0;
}

/** A seeded uniform [0, 1) generator (mulberry32), so a failing order can be replayed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** `items` in a random order: each sorted by a random key. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  return items
    .map((item) => ({ item, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
