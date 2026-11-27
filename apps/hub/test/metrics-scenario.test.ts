import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { adminRequest, postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { scrapeMetrics, valueOf, type Sample } from './support/metrics.js';
import { awaitRun, requestRun } from './support/reconciliation.js';
import {
  bootMock,
  world,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldEnv,
  worldPrescriptionWritten,
  worldVisitFinished,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';

/** Every label key a metric of the catalogue (#15, #17, #20) may carry; `le` is a histogram bucket's. */
const LABEL_KEYS = new Set([
  'event_type',
  'status',
  'code',
  'previous_status',
  'step',
  'outcome',
  'reason',
  'upstream',
  'operation',
  'status_class',
  'mode',
  'cache',
  'result',
  'trigger',
  'class',
  'le',
]);

/**
 * The most series both processes may expose together (#15), fixed before
 * any scrape: the catalogue's closed sets allow under 2,000 in any run this
 * suite makes (worker: attempt histograms 4 steps × 5 outcomes × 16 lines,
 * platform API histograms 5 operations × 6 status classes × 16, and the
 * rest; hub: ingest histograms per event type and status, and the gauges);
 * anything past this bound is an unbounded label.
 */
const MAX_SERIES = 2_000;

/** The gauges derived from database state: the hub service's alone (#15). */
const DATABASE_GAUGES = [
  'cases',
  'cases_stalled',
  'cases_dead_lettered_oldest_age_seconds',
  'outbox_lag_seconds',
  'outbox_claimable_steps',
  'reconciliation_divergences',
  'reconciliation_last_completed_timestamp_seconds',
];

describe('metrics after a scenario run: closed label sets, each from the process doing the work (#41)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;
  let hubSamples: Sample[] = [];
  let workerSamples: Sample[] = [];

  const send = (body: unknown, options: { idempotencyKey?: string; apiKey?: string | null } = {}) =>
    postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body, ...options });

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), RETRY_BACKOFF_BASE_MS: '10', RETRY_BACKOFF_CAP_MS: '50' };
    hub = await bootHub(env);
    worker = await bootWorker(env);

    // A whole visit, its first Encounter POST failing transiently.
    await mock.client.setFaults({ seed: 41, rules: [{ id: 'enc-500', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', firstN: 1 }] });
    const started = worldVisitStarted();
    const prescription = worldPrescriptionWritten(started.visitId);
    const key = randomUUID();
    const accepted = await send(started, { idempotencyKey: key });
    expect(accepted.status).toBe(202);
    for (const event of [prescription, worldDrugDispensed(prescription), worldVisitFinished(started)]) expect((await send(event)).status).toBe(202);
    await waitForCase(hub.baseUrl, accepted.headers.get('location'), (v) => v.status === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });

    // A duplicate, an unauthenticated event and one that fails the schema.
    expect((await send(started, { idempotencyKey: key })).status).toBe(202);
    expect((await send(started, { apiKey: null })).status).toBe(401);
    expect((await send({ ...started, data: { ...started.data, startedAt: 'not a time' } })).status).toBe(422);

    // A visit whose patient search is rejected, dead-lettered, then abandoned.
    await mock.client.setFaults({ seed: 41, rules: [{ id: 'search-400', match: { method: 'GET', resourceType: 'Patient' }, kind: 'http_400', firstN: 1 }] });
    const patient = world.patients[1];
    if (!patient) throw new Error('the world dataset needs a second patient');
    const rejected = await send(worldVisitStarted({ patient: { nik: patient.nik, mrn: 'MRN-41' } }));
    const deadLettered = await waitForCase(hub.baseUrl, rejected.headers.get('location'), (v) => v.status === 'dead_lettered', { apiKey: WORLD_SOURCE_API_KEY });
    const abandoned = await adminRequest(hub.baseUrl, 'POST', `v1/cases/${deadLettered.caseId}/abandon`, { body: { note: 'metrics scenario' } });
    expect(abandoned.status).toBe(200);
    await mock.client.setFaults({ seed: 41, rules: [] });

    // An on-demand reconciliation run over both cases.
    await awaitRun(hub.baseUrl, await requestRun(hub.baseUrl, {}));

    hubSamples = await scrapeMetrics(hub.baseUrl);
    workerSamples = await scrapeMetrics(worker.baseUrl);
  }, 60_000);

  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  it('every label key is on the allowlist, and both processes together stay under the series bound', () => {
    for (const samples of [hubSamples, workerSamples]) {
      for (const sample of samples) for (const key of Object.keys(sample.labels)) expect(LABEL_KEYS, `${sample.name} has label "${key}"`).toContain(key);
      expect(samples.length).toBeGreaterThan(0);
    }
    expect(hubSamples.length + workerSamples.length).toBeLessThan(MAX_SERIES);
  });

  it('work metrics come from the worker, and database-derived gauges only from the hub service', () => {
    const names = (samples: Sample[]) => new Set(samples.map((s) => s.name));
    for (const gauge of DATABASE_GAUGES) {
      expect(names(hubSamples), gauge).toContain(gauge);
      expect(names(workerSamples), gauge).not.toContain(gauge);
    }
    expect(names(workerSamples)).toContain('step_attempts_total');
    expect(names(hubSamples)).not.toContain('step_attempts_total');
  });

  it('the hub service counts ingest, duplicates, rejections and the abandonment, and shows the cases where they are', () => {
    expect(valueOf(hubSamples, 'ingest_request_duration_seconds_count', { event_type: 'visit.started', status: '202' })).toBe(3);
    expect(valueOf(hubSamples, 'ingest_duplicates_total', { event_type: 'visit.started' })).toBe(1);
    expect(valueOf(hubSamples, 'ingest_rejections_total', { code: 'UNAUTHENTICATED' })).toBe(1);
    expect(valueOf(hubSamples, 'ingest_rejections_total', { code: 'VALIDATION_FAILED' })).toBe(1);
    expect(valueOf(hubSamples, 'cases_abandoned_total', { previous_status: 'dead_lettered' })).toBe(1);
    expect(valueOf(hubSamples, 'cases', { status: 'completed' })).toBe(1);
    expect(valueOf(hubSamples, 'cases', { status: 'abandoned' })).toBe(1);
    expect(valueOf(hubSamples, 'outbox_claimable_steps')).toBe(0);
  });

  it('the worker counts attempts by outcome, completions, and dead-letters by reason', () => {
    expect(valueOf(workerSamples, 'step_attempts_total', { step: 'create_visit', outcome: 'transient' })).toBe(1);
    expect(valueOf(workerSamples, 'step_attempts_total', { step: 'create_visit', outcome: 'success' })).toBe(1);
    expect(valueOf(workerSamples, 'step_attempts_total', { step: 'create_visit', outcome: 'permanent' })).toBe(1);
    expect(valueOf(workerSamples, 'step_attempt_duration_seconds_count', { step: 'update_visit', outcome: 'success' })).toBe(1);
    for (const step of ['create_visit', 'submit_prescription', 'submit_dispense', 'update_visit']) {
      expect(valueOf(workerSamples, 'steps_completed_total', { step }), step).toBe(1);
    }
    expect(valueOf(workerSamples, 'steps_dead_lettered_total', { step: 'create_visit' })).toBe(1);
  });

  it('the worker measures upstream calls by API, operation and status class, its breakers and its rate limiter', () => {
    const calls = (labels: Record<string, string>) => valueOf(workerSamples, 'upstream_request_duration_seconds_count', labels);
    expect(calls({ upstream: 'fhir', operation: 'create', status_class: '5xx' })).toBe(1);
    expect(calls({ upstream: 'fhir', operation: 'create', status_class: '2xx' })).toBeGreaterThanOrEqual(3);
    expect(calls({ upstream: 'fhir', operation: 'update', status_class: '2xx' })).toBe(1);
    expect(calls({ upstream: 'fhir', operation: 'search', status_class: '4xx' })).toBe(1);
    expect(calls({ upstream: 'fhir', operation: 'search', status_class: '2xx' })).toBeGreaterThan(0);
    expect(calls({ upstream: 'kfa', operation: 'lookup', status_class: '2xx' })).toBeGreaterThan(0);
    expect(calls({ upstream: 'auth', operation: 'token', status_class: '2xx' })).toBeGreaterThan(0);
    for (const upstream of ['fhir', 'kfa', 'auth']) expect(valueOf(workerSamples, 'circuit_breaker_state', { upstream }), upstream).toBe(0);
    expect(valueOf(workerSamples, 'circuit_breaker_opens_total')).toBe(0);
    expect(valueOf(workerSamples, 'rate_limiter_wait_seconds_count', { upstream: 'fhir', mode: 'redis' })).toBeGreaterThan(0);
  });

  it('the worker counts its reconciliation run and checks; the hub service shows the run it completed', () => {
    expect(valueOf(workerSamples, 'reconciliation_runs_total', { trigger: 'operator', outcome: 'completed' })).toBe(1);
    expect(valueOf(workerSamples, 'reconciliation_run_duration_seconds_count')).toBe(1);
    expect(valueOf(workerSamples, 'reconciliation_checks_total', { result: 'ok' })).toBe(2);
    expect(valueOf(hubSamples, 'reconciliation_divergences')).toBe(0);
    expect(valueOf(hubSamples, 'reconciliation_last_completed_timestamp_seconds')).toBeGreaterThan(Date.now() / 1000 - 60);
  });
});
