import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { startTracing, type Tracing } from '../src/observability/tracing.js';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { scrapeMetrics, type Sample } from './support/metrics.js';
import { readRedis } from './support/redis-contents.js';
import { collectingExporter } from './support/traces.js';
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

/** Every personal value of the world dataset: none may reach a log line. */
const CANARIES = [...world.patients, ...world.practitioners].flatMap((person) => [
  person.nik,
  person.name,
  person.birthDate,
  person.ihsNumber,
  ...('motherNik' in person ? [person.motherNik] : []),
]);

/** Every NIK of the world dataset: none may reach Redis, in a key or a value (#47). */
const CANARY_NIKS = [...world.patients, ...world.practitioners].flatMap((person) => [person.nik, ...('motherNik' in person ? [person.motherNik] : [])]);

const lineSchema = z
  .object({
    time: z.iso.datetime(),
    level: z.enum(['info', 'warn', 'error']),
    msg: z.string(),
    service: z.enum(['hub', 'worker']),
  })
  .loose();
type Line = z.infer<typeof lineSchema>;

describe('logs, metrics and traces: structured, tied to their case, and free of personal data', () => {
  const written: string[] = [];
  const exporter = collectingExporter();
  let tracing: Tracing;
  let spans: ReadableSpan[] = [];
  const logs = { write: (line: string) => void written.push(line) };
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;
  const visitIds: string[] = [];
  const caseIds: Record<'completed' | 'searchEchoed' | 'createEchoed', string> = { completed: '', searchEchoed: '', createEchoed: '' };
  let lines: Line[] = [];
  /** Both processes' `/metrics` samples after the scenario. */
  let scraped: Sample[][] = [];
  /** Every key in Redis after the scenario, and every string value. */
  let redisContents: { keys: string[]; values: string[] } = { keys: [], values: [] };
  let closed = false;

  const send = (body: unknown, options: { idempotencyKey?: string; apiKey?: string | null } = {}) =>
    postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body, ...options });
  const caseIdOf = (res: Response) => res.headers.get('location')?.split('/').at(-1) ?? '';

  /** Starts a visit for the world's `n`th patient and resolves once create visit is dead-lettered. */
  async function deadLetteredVisit(n: number): Promise<string> {
    const patient = world.patients[n];
    if (!patient) throw new Error(`the world dataset needs a patient #${n}`);
    const started = worldVisitStarted({ patient: { nik: patient.nik, mrn: `MRN-${n}` } });
    visitIds.push(started.visitId);
    const res = await send(started);
    expect(res.status).toBe(202);
    await waitForCase(hub.baseUrl, res.headers.get('location'), (v) => v.status === 'dead_lettered', { apiKey: WORLD_SOURCE_API_KEY });
    return caseIdOf(res);
  }

  beforeAll(async () => {
    tracing = startTracing({ service: 'hub', sampleRatio: 1, exporter });
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), RETRY_BACKOFF_BASE_MS: '10', RETRY_BACKOFF_CAP_MS: '50' };
    hub = await bootHub(env, undefined, logs);
    worker = await bootWorker(env, logs);

    // A whole visit, its first Encounter POST failing transiently.
    await mock.client.setFaults({ seed: 40, rules: [{ id: 'enc-500', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_500', firstN: 1 }] });
    const started = worldVisitStarted();
    const prescription = worldPrescriptionWritten(started.visitId);
    visitIds.push(started.visitId);
    const key = randomUUID();
    const accepted = await send(started, { idempotencyKey: key });
    expect(accepted.status).toBe(202);
    caseIds.completed = caseIdOf(accepted);
    for (const event of [prescription, worldDrugDispensed(prescription), worldVisitFinished(started)]) expect((await send(event)).status).toBe(202);
    await waitForCase(hub.baseUrl, accepted.headers.get('location'), (v) => v.status === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });

    // A duplicate ingest, an unauthenticated event and one that fails the schema, each carrying a NIK.
    expect((await send(started, { idempotencyKey: key })).status).toBe(202);
    expect((await send(started, { apiKey: null })).status).toBe(401);
    expect((await send({ ...started, data: { ...started.data, startedAt: 'not a time' } })).status).toBe(422);

    // The OperationOutcome echoes the `Patient?identifier=…|<NIK>` search, then an Encounter POST's body.
    await mock.client.setFaults({
      seed: 40,
      rules: [{ id: 'echo-search', match: { method: 'GET', resourceType: 'Patient' }, kind: 'http_400', params: { echoRequest: true }, firstN: 1 }],
    });
    caseIds.searchEchoed = await deadLetteredVisit(1);
    await mock.client.setFaults({
      seed: 40,
      rules: [{ id: 'echo-create', match: { method: 'POST', resourceType: 'Encounter' }, kind: 'http_400', params: { echoRequest: true }, firstN: 1 }],
    });
    caseIds.createEchoed = await deadLetteredVisit(2);

    scraped = await Promise.all([hub.baseUrl, worker.baseUrl].map(scrapeMetrics));
    redisContents = await readRedis(loadConfig(process.env).redisUrl);

    // Closed here, so every line either process writes is captured before the assertions read them.
    closed = true;
    await worker.close();
    await hub.close();
    await tracing.shutdown();
    spans = exporter.spans;
    lines = written.map((line) => lineSchema.parse(JSON.parse(line)));
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

  it('no captured line holds a canary value, a 16-digit run, or a visit id', () => {
    expect(written.length).toBeGreaterThan(10);
    for (const line of written) {
      for (const canary of [...CANARIES, ...visitIds]) expect(line, `a line holds "${canary}"`).not.toContain(canary);
      expect(line).not.toMatch(/\d{16}/);
      expect(line).not.toContain('"visitId"');
    }
  });

  it('no metric label of either process holds a canary value, a 16-digit run, or a visit id (#41)', () => {
    const [hubSamples = [], workerSamples = []] = scraped;
    expect(hubSamples.some((m) => m.name === 'ingest_request_duration_seconds_count')).toBe(true);
    expect(workerSamples.some((m) => m.name === 'upstream_request_duration_seconds_count')).toBe(true);
    const labelValues = [...hubSamples, ...workerSamples].flatMap((m) => Object.values(m.labels)).join('\n');
    for (const canary of [...CANARIES, ...visitIds]) expect(labelValues.includes(canary), `a metric label holds "${canary}"`).toBe(false);
    expect(labelValues).not.toMatch(/\d{16}/);
  });

  it('no span name, attribute, event or status message holds a canary value, a 16-digit run, or a visit id (#42)', () => {
    expect(spans.some((s) => s.name === 'ihs.lookup')).toBe(true);
    expect(spans.some((s) => s.events.some((e) => e.name === 'exception'))).toBe(true);
    for (const span of spans) {
      const exported = JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status, links: span.links });
      for (const canary of [...CANARIES, ...visitIds]) expect(exported, `span ${span.name} holds "${canary}"`).not.toContain(canary);
      expect(exported).not.toMatch(/\d{16}/);
    }
  });

  it('no Redis key or value holds a canary NIK; no value holds a 16-digit run (#47)', () => {
    const { keys, values } = redisContents;
    expect(keys.some((key) => key.startsWith('ihs:patient:'))).toBe(true);
    for (const entry of [...keys, ...values]) {
      for (const nik of CANARY_NIKS) expect(entry, `Redis holds "${nik}"`).not.toContain(nik);
    }
    // Not keys: an HMAC's hex digest may hold 16 decimal digits in a row by chance.
    for (const value of values) expect(value).not.toMatch(/\d{16}/);
  });

  it('each service logs as itself, and case-scoped lines carry the case id', () => {
    expect(lines).toContainEqual(expect.objectContaining({ service: 'hub', level: 'info', msg: 'source event accepted', caseId: caseIds.completed }));
    expect(lines).toContainEqual(expect.objectContaining({ service: 'worker', msg: 'worker claiming steps' }));
  });

  it('a line logged in a traced request or attempt carries its trace and span ids (#40, #42)', () => {
    const traced = { traceId: expect.stringMatching(/^[0-9a-f]{32}$/), spanId: expect.stringMatching(/^[0-9a-f]{16}$/) };
    const accepted = lines.find((l) => l.msg === 'source event accepted' && l.caseId === caseIds.completed);
    expect(accepted).toMatchObject(traced);
    const failed = lines.find((l) => l.service === 'worker' && l.caseId === caseIds.completed && l.level === 'warn');
    expect(failed).toMatchObject(traced);
    expect(spans.some((s) => s.spanContext().traceId === failed?.traceId && s.spanContext().spanId === failed?.spanId && s.name === 'step.attempt')).toBe(true);
  });

  it('a transient attempt failure is a warn with its step, attempt and code', () => {
    expect(lines).toContainEqual(
      expect.objectContaining({ service: 'worker', level: 'warn', caseId: caseIds.completed, step: 'create_visit', attempt: 1, errorCode: 'failed' }),
    );
  });

  it('a permanent failure is an error, and its OperationOutcome text is not logged', () => {
    for (const caseId of [caseIds.searchEchoed, caseIds.createEchoed]) {
      const line = lines.find((l) => l.caseId === caseId && l.level === 'error');
      expect(line).toMatchObject({ service: 'worker', step: 'create_visit', errorCode: 'PAYLOAD_INVALID' });
      expect(JSON.stringify(line)).not.toContain('rejected by mock fault rule');
    }
  });

  it('duplicates and rejections are info, with the request id, source and event type', () => {
    const requestLine = { service: 'hub', level: 'info', requestId: expect.any(String) };
    const sourceEvent = { source: 'simulator', eventType: 'visit.started' };
    expect(lines).toContainEqual(expect.objectContaining({ ...requestLine, ...sourceEvent, msg: expect.stringContaining('duplicate ingest') }));
    expect(lines).toContainEqual(expect.objectContaining({ ...requestLine, errorCode: 'UNAUTHENTICATED' }));
    expect(lines).toContainEqual(expect.objectContaining({ ...requestLine, ...sourceEvent, errorCode: 'VALIDATION_FAILED' }));
  });
});
