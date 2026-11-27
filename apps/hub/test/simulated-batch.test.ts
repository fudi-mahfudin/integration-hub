import { planBatch, runBatch, type BatchResult, type Plan } from '@integration-hub/simulator';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { getCase, caseViewSchema } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { bootMock, world, WORLD_SOURCE_API_KEY, worldEnv, type BootedMock } from './support/satusehat.js';

describe('a simulated batch flows through the hub to the mock SATUSEHAT (#44)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;
  let plan: Plan;
  let result: BatchResult;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    worker = await bootWorker(env);
    // Every share in use, with short holds and delays so the batch ends in seconds.
    plan = planBatch(world, {
      seed: 44,
      runId: randomUUID().slice(0, 8),
      visits: 12,
      eventsPerSecond: 50,
      outOfOrder: { share: 0.25, delayMs: 300 },
      substitutionShare: 0.25,
      fallbackLookupShare: 0.25,
      duplicates: { perEvent: 0.25, concurrent: 0.5, delayed: 0.3, late: 0.2, delayedWindowMs: { min: 100, max: 1_000 } },
    });
    result = await runBatch(plan, { baseUrl: hub.baseUrl, apiKey: WORLD_SOURCE_API_KEY }, { pollIntervalMs: 200, completionTimeoutMs: 45_000, report: () => {} });
  }, 60_000);

  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  it('answers every original 202 and every duplicate 202 + Idempotent-Replayed, and completes every case', () => {
    expect(result.problems).toEqual([]);
    expect(result.cases.map((c) => c.status)).toEqual(plan.visits.map(() => 'completed'));
  });

  it('counts each duplicate ingest on its case', async () => {
    for (const { visitId, caseId } of result.cases) {
      const view = caseViewSchema.parse(await (await getCase(hub.baseUrl, caseId, WORLD_SOURCE_API_KEY)).json());
      const planned = plan.sends.filter((s) => s.visitId === visitId && s.duplicate !== null).length;
      expect(view.events.reduce((sum, e) => sum + e.duplicates, 0)).toBe(planned);
    }
  });

  it('lands the four effects of every visit at the mock once each, in order, with nothing duplicated or overlapping', async () => {
    for (const { visitId } of plan.visits) {
      const effects = (await mock.client.log({ visitKey: visitId })).filter((e) => e.effect === 'created' || e.effect === 'updated');
      expect(effects.map((e) => `${e.resourceType} ${e.effect}`)).toEqual([
        'Encounter created',
        'MedicationRequest created',
        'MedicationDispense created',
        'Encounter updated',
      ]);
    }
    const report = await mock.client.report();
    expect(report.duplicates).toEqual([]);
    expect(report.outOfOrder).toEqual([]);
    expect(report.overlap).toEqual([]);
  });
});
