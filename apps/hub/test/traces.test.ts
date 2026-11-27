import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTracing, type Tracing } from '../src/observability/tracing.js';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { awaitRun, requestRun } from './support/reconciliation.js';
import { collectingExporter } from './support/traces.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import {
  bootMock,
  WORLD_SOURCE_API_KEY,
  worldDrugDispensed,
  worldEnv,
  worldPrescriptionWritten,
  worldVisitFinished,
  worldVisitStarted,
  type BootedMock,
} from './support/satusehat.js';


/** The event type that delivers each step's event (#6). */
const EVENT_OF_STEP = {
  create_visit: 'visit.started',
  submit_prescription: 'prescription.written',
  submit_dispense: 'drug.dispensed',
  update_visit: 'visit.finished',
} as const;
const isStepName = (value: unknown): value is keyof typeof EVENT_OF_STEP => typeof value === 'string' && value in EVENT_OF_STEP;

describe('traces: one visit followed from event arrival to each SATUSEHAT call (#42)', () => {
  const exporter = collectingExporter();
  let tracing: Tracing;
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;
  let caseId = '';
  let spans: ReadableSpan[] = [];
  let closed = false;

  const named = (name: string) => spans.filter((s) => s.name === name);
  const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

  beforeAll(async () => {
    tracing = startTracing({ service: 'hub', sampleRatio: 1, exporter });
    mock = await bootMock();
    database = await createFreshDatabase();
    // The live sandbox's rate limit (FHIR 5 rps, a burst of 5), so the visit's later calls wait their turn.
    const env = { ...worldEnv(mock.baseUrl, database.url), RETRY_BACKOFF_BASE_MS: '10', RETRY_BACKOFF_CAP_MS: '50', SATUSEHAT_PROFILE: 'live-sandbox' };
    hub = await bootHub(env);
    worker = await bootWorker(env);

    // The first Encounter POST fails transiently (a second attempt), and the first Patient search answers 500 (a read retry).
    await mock.client.setFaults({
      seed: 42,
      rules: [
        { id: 'enc-500', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', firstN: 1 },
        { id: 'patient-500', match: { method: 'GET', resourceType: 'Patient' }, kind: 'http_500', firstN: 1 },
      ],
    });
    const started = worldVisitStarted();
    const prescription = worldPrescriptionWritten(started.visitId);
    const accepted = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: started });
    expect(accepted.status).toBe(202);
    caseId = accepted.headers.get('location')?.split('/').at(-1) ?? '';
    for (const event of [prescription, worldDrugDispensed(prescription), worldVisitFinished(started)]) {
      expect((await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: event })).status).toBe(202);
    }
    await waitForCase(hub.baseUrl, accepted.headers.get('location'), (v) => v.status === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });
    // Reconciliation checks the case outside any attempt.
    expect((await awaitRun(hub.baseUrl, await requestRun(hub.baseUrl, { caseIds: [caseId] }))).status).toBe('completed');

    closed = true;
    await worker.close();
    await hub.close();
    await tracing.shutdown();
    spans = exporter.spans;
  }, 60_000);

  afterAll(async () => {
    if (!closed) {
      await worker?.close();
      await hub?.close();
      await tracing?.shutdown();
    }
    await database?.drop();
    await mock?.close();
  });

  it('each event is accepted under a POST /v1/events span, and each step attempt is a child of the ingest span that delivered its event', () => {
    const accepts = named('ingest.accept');
    expect(accepts.map((s) => s.attributes['event.type']).sort()).toEqual(['drug.dispensed', 'prescription.written', 'visit.finished', 'visit.started']);
    for (const accept of accepts) {
      const server = spans.find((s) => s.spanContext().spanId === parentOf(accept));
      expect(server?.name).toBe('POST /v1/events');
    }

    const attempts = named('step.attempt');
    expect(attempts.map((s) => `${s.attributes.step}#${s.attributes.attempt}:${s.attributes.outcome}`).sort()).toEqual([
      'create_visit#1:failed',
      'create_visit#2:completed',
      'submit_dispense#1:completed',
      'submit_prescription#1:completed',
      'update_visit#1:completed',
    ]);
    for (const attempt of attempts) {
      const { step } = attempt.attributes;
      if (!isStepName(step)) throw new Error(`a step.attempt span names no step: ${String(step)}`);
      const accept = accepts.find((s) => s.attributes['event.type'] === EVENT_OF_STEP[step]);
      expect(attempt.spanContext().traceId).toBe(accept?.spanContext().traceId);
      expect(parentOf(attempt)).toBe(accept?.spanContext().spanId);
    }
  });

  it('under its attempt: the SATUSEHAT and KFA calls, IHS-number lookups and the token fetch', () => {
    const attemptOf = (span: ReadableSpan): ReadableSpan | undefined => {
      if (span.name === 'step.attempt') return span;
      const parent = spans.find((s) => s.spanContext().spanId === parentOf(span));
      return parent && attemptOf(parent);
    };
    const under = (step: string, name: string) => named(name).filter((s) => attemptOf(s)?.attributes.step === step);

    expect(under('create_visit', 'ihs.lookup').map((s) => s.attributes.person).sort()).toEqual(['patient', 'patient', 'practitioner', 'practitioner']);
    expect(under('create_visit', 'satusehat.create')).toHaveLength(2);
    expect(under('create_visit', 'auth.token')).toHaveLength(1);
    expect(under('submit_prescription', 'kfa.lookup').length).toBeGreaterThan(0);
    expect(under('submit_prescription', 'satusehat.create')).toHaveLength(1);
    expect(under('update_visit', 'satusehat.update')).toHaveLength(1);
    // A call that waited for the rate limit; one that didn't makes no span.
    const waits = spans.filter((s) => s.name === 'rate_limiter.wait' && attemptOf(s) !== undefined);
    expect(waits.length).toBeGreaterThan(0);
    for (const wait of waits) expect(wait.attributes).toMatchObject({ api: 'fhir', mode: 'redis', 'wait.ms': expect.any(Number) });

    // The Patient search that answered 500 was sent again in-process: each read retry its own span.
    // The second attempt took the patient from the IHS-number cache, and searched for no one (#47).
    const patientSearches = under('create_visit', 'satusehat.search').filter((s) => String(s.attributes['url.path']).endsWith('/Patient'));
    expect(patientSearches.map((s) => s.attributes.read_retry)).toEqual([0, 1]);
    expect(patientSearches[0]?.attributes['http.response.status_code']).toBe(500);
  });

  it('the HTTP client, pg and ioredis are traced: the path without its query, statement text without parameters, the command name only', () => {
    const scope = (span: ReadableSpan) => span.instrumentationScope.name;
    const client = spans.filter((s) => scope(s) === '@opentelemetry/instrumentation-undici');
    expect(client.some((s) => String(s.attributes['url.full']).endsWith('/fhir-r4/v1/Patient'))).toBe(true);
    for (const span of client) {
      expect(String(span.attributes['url.full'])).not.toContain('?');
      expect(span.attributes['url.query']).toBeUndefined();
    }

    const queries = spans.filter((s) => scope(s) === '@opentelemetry/instrumentation-pg' && s.attributes['db.query.text'] !== undefined);
    expect(queries.some((s) => String(s.attributes['db.query.text']).includes('insert into "source_event"'))).toBe(true);
    for (const span of queries) expect(Object.keys(span.attributes).filter((k) => k.includes('parameter') || k.includes('values'))).toEqual([]);

    const commands = spans.filter((s) => scope(s) === '@opentelemetry/instrumentation-ioredis');
    expect(commands.length).toBeGreaterThan(0);
    for (const span of commands) expect(span.attributes['db.query.text']).toMatch(/^[a-z]+$/);
  });

  it('every span of an attempt carries the case id, and a poll that claims nothing makes no span', () => {
    const attemptIds = new Set(named('step.attempt').map((s) => s.spanContext().spanId));
    const underAnAttempt = (span: ReadableSpan): boolean => {
      const parent = spans.find((s) => s.spanContext().spanId === parentOf(span));
      return parent !== undefined && (attemptIds.has(parent.spanContext().spanId) || underAnAttempt(parent));
    };
    const caseSpans = [...named('POST /v1/events'), ...named('ingest.accept'), ...named('step.claim'), ...named('step.attempt'), ...spans.filter(underAnAttempt)];
    expect(caseSpans.length).toBeGreaterThan(30);
    for (const span of caseSpans) expect(span.attributes['case.id'], `${span.name} carries the case id`).toBe(caseId);

    // The worker polled every 20ms while the case ran, but claimed five times.
    expect(named('step.claim')).toHaveLength(5);
  });

  it('a reconciliation check of the case is its own trace, its searches under it, all carrying the case id', () => {
    const [check, ...more] = named('reconciliation.check');
    expect(more).toEqual([]);
    expect(check?.parentSpanContext).toBeUndefined();
    expect(check?.attributes).toMatchObject({ 'case.id': caseId, outcome: 'clean' });
    const inCheck = spans.filter((s) => s.spanContext().traceId === check?.spanContext().traceId);
    expect(inCheck.filter((s) => s.name === 'satusehat.search').length).toBeGreaterThanOrEqual(3);
    for (const span of inCheck) expect(span.attributes['case.id'], `${span.name} carries the case id`).toBe(caseId);
  });
});

