import type { FaultRulesInput } from '@integration-hub/mock-satusehat/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitEvents, type BootedMock } from './support/satusehat.js';

type FaultRule = FaultRulesInput['rules'][number];

/** Short, so a `timeout_after_apply` (held 1s) times out quickly. */
const CALL_TIMEOUT_MS = 500;

const writes = [
  { step: 'create_visit', method: 'POST', resourceType: 'Encounter', effect: 'Encounter created' },
  { step: 'submit_prescription', method: 'POST', resourceType: 'MedicationRequest', effect: 'MedicationRequest created' },
  { step: 'submit_dispense', method: 'POST', resourceType: 'MedicationDispense', effect: 'MedicationDispense created' },
  { step: 'update_visit', method: 'PUT', resourceType: 'Encounter', effect: 'Encounter updated' },
] as const;

/** `httpStatus`: what the failed attempt logs, the last answer it read (after a timeout, its search's 200). */
type Match = { method: 'POST' | 'PUT'; resourceType: string };
const faults: { kind: string; rule: (match: Match) => FaultRule; httpStatus: number }[] = [
  {
    kind: 'timeout_after_apply',
    rule: (match) => ({ id: 'applied-then-failed', match, firstN: 1, kind: 'timeout_after_apply', params: { ms: 1_000 } }),
    httpStatus: 200,
  },
  { kind: 'http_500_after_apply', rule: (match) => ({ id: 'applied-then-failed', match, firstN: 1, kind: 'http_500_after_apply' }), httpStatus: 500 },
];

describe('a write SATUSEHAT applied but answered badly (apply-then-fail) causes exactly one effect', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), SATUSEHAT_CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS) };
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });
  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  describe.each(faults)('$kind', ({ rule, httpStatus }) => {
    it.each(writes)('on $method $resourceType ($step): the next attempt adopts the applied record', async ({ step, method, resourceType }) => {
      await mock.client.setFaults({ seed: 35, rules: [rule({ method, resourceType })] });
      const { visit, events } = worldVisitEvents();
      let location: string | null = null;
      for (const body of events) location = (await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body })).headers.get('location');

      const view = await waitForCase(hub.baseUrl, location, (v) => v.status === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });

      // A request cut without an answer is logged when the mock drops it, which may be after the case completed.
      const logged = await eventually(async () => {
        const entries = await mock.client.log({ visitKey: visit.visitId });
        return entries.some((e) => e.fault === 'applied-then-failed') ? entries : undefined;
      });
      const effects = logged.filter((e) => e.effect !== 'none');
      // A dropped request is logged when it is dropped, so the log's order isn't the effects' order; the report checks that.
      expect(effects.map((e) => `${e.resourceType} ${e.effect}`).sort()).toEqual(writes.map((w) => w.effect).sort());
      expect(effects.find((e) => e.fault === 'applied-then-failed')).toBeDefined();
      const faulted = view.steps.find((s) => s.step === step);
      expect(faulted?.attemptLog.map((a) => [a.outcome, a.httpStatus])).toEqual([
        ['failed', httpStatus],
        ['completed', 200],
      ]);
      const report = await mock.client.report();
      expect(report.duplicates.filter((d) => d.visitKey === visit.visitId)).toEqual([]);
      expect(report.outOfOrder.filter((o) => o.visitKey === visit.visitId)).toEqual([]);
      expectAtMostOneStepInMotion(view);
    });
  });
});

/** Polls `find` every 50ms until it resolves to something, and resolves to that. Fails after 5s. */
async function eventually<T>(find: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = await find();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('nothing was found within 5s');
}
