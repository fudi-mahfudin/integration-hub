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
    result = await runBatch(
      plan,
      { baseUrl: hub.baseUrl, apiKey: WORLD_SOURCE_API_KEY },
      { pollIntervalMs: 200, noProgressTimeoutMs: 30_000, deadlineMs: 45_000, report: () => {} },
    );
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
    expect(result.ending).toBe('completed');
  });

  it('records every answer: each original once, each duplicate once, with its latency', () => {
    const duplicated = plan.sends.filter((s) => s.duplicate !== null);
    expect(result.answers.filter((a) => a.role === 'original')).toHaveLength(plan.sends.length);
    expect(result.answers.filter((a) => a.role === 'duplicate').map((a) => a.idempotencyKey).toSorted()).toEqual(
      duplicated.map((s) => s.idempotencyKey).toSorted(),
    );
    for (const answer of result.answers) {
      expect(answer.status).toBe(202);
      expect(answer.replayed).toBe(answer.role === 'duplicate');
      expect(answer.latencyMs).toBeGreaterThan(0);
    }
    // A late duplicate goes only after its case completed, so after every original of its visit was answered.
    const late = result.answers.filter((a) => a.role === 'duplicate' && a.timing === 'late');
    expect(late.length).toBe(duplicated.filter((s) => s.duplicate?.kind === 'late').length);
    for (const answer of late) {
      const originals = result.answers.filter((a) => a.visitId === answer.visitId && a.role === 'original');
      expect(answer.sentAfterMs).toBeGreaterThanOrEqual(Math.max(...originals.map((a) => a.sentAfterMs + a.latencyMs)));
    }
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

describe('a batch the hub cannot deliver ends without waiting forever (#45)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    // No worker: every case stays active, so no step ever completes.
    hub = await bootHub(worldEnv(mock.baseUrl, database.url));
  });

  afterAll(async () => {
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  const stuckPlan = () =>
    planBatch(world, {
      seed: 45,
      runId: randomUUID().slice(0, 8),
      visits: 2,
      eventsPerSecond: 100,
      outOfOrder: { share: 0, delayMs: 0 },
      substitutionShare: 0,
      fallbackLookupShare: 0,
      duplicates: { perEvent: 0, concurrent: 1, delayed: 0, late: 0, delayedWindowMs: { min: 0, max: 0 } },
    });

  it('fails fast once no step has completed for the no-progress timeout, naming each stuck case', async () => {
    const plan = stuckPlan();
    const result = await runBatch(
      plan,
      { baseUrl: hub.baseUrl, apiKey: WORLD_SOURCE_API_KEY },
      { pollIntervalMs: 100, noProgressTimeoutMs: 600, deadlineMs: 20_000, report: () => {} },
    );
    expect(result.ending).toBe('no_progress');
    expect(result.endedAfterMs).toBeLessThan(10_000);
    expect(result.cases.map((c) => [c.status, c.currentStep])).toEqual([
      ['active', 'create_visit'],
      ['active', 'create_visit'],
    ]);
    for (const { visitId } of plan.visits) expect(result.problems.some((p) => p.startsWith(visitId))).toBe(true);
  });

  it('stops at the hard deadline, counted from the first send', async () => {
    const result = await runBatch(
      stuckPlan(),
      { baseUrl: hub.baseUrl, apiKey: WORLD_SOURCE_API_KEY },
      { pollIntervalMs: 100, noProgressTimeoutMs: 20_000, deadlineMs: 800, report: () => {} },
    );
    expect(result.ending).toBe('deadline');
    expect(result.endedAfterMs).toBeGreaterThanOrEqual(800);
    expect(result.endedAfterMs).toBeLessThan(10_000);
  });
});
