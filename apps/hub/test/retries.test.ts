import type { FaultRulesInput } from '@integration-hub/mock-satusehat/client';
import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { expectAtMostOneStepInMotion } from './support/invariants.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitStarted, type BootedMock } from './support/satusehat.js';

describe('retries of transient failures and dead-lettering of permanent ones (#13)', () => {
  let mock: BootedMock | undefined;
  let database: FreshDatabase | undefined;
  let hub: BootedHub | undefined;
  let worker: BootedWorker | undefined;

  afterEach(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
    worker = hub = database = mock = undefined;
  });

  /** Boots a mock with `faults`, a hub and a worker; sends a world visit; resolves to its case once `done` holds. */
  async function visitWith(faults: FaultRulesInput['rules'], done: (v: CaseView) => boolean, env: Record<string, string> = {}) {
    mock = await bootMock();
    database = await createFreshDatabase();
    const fullEnv = { ...worldEnv(mock.baseUrl, database.url), ...env };
    hub = await bootHub(fullEnv);
    await mock.client.setFaults({ seed: 35, rules: faults });
    worker = await bootWorker(fullEnv);
    const visit = worldVisitStarted();
    const accepted = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: visit });
    const view = await waitForCase(hub.baseUrl, accepted.headers.get('location'), done, { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });
    return { visit, view, mock };
  }
  const createVisit = (v: CaseView) => v.steps[0];

  it('a 500 on a create ends the attempt transient; the next attempt completes the step, and the write was sent once per attempt', async () => {
    const { visit, view, mock } = await visitWith(
      [{ id: 'create-500', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind: 'http_500' }],
      (v) => createVisit(v)?.state === 'completed',
    );

    expect(createVisit(view)?.attemptLog).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'failed', errorCode: null, httpStatus: 500 }),
      expect.objectContaining({ attempt: 2, outcome: 'completed', httpStatus: 201 }),
    ]);
    const creates = await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' });
    expect(creates.filter((e) => e.method === 'POST').map((e) => e.response.status)).toEqual([500, 201]);
    expectAtMostOneStepInMotion(view);
  });

  it.each([
    ['a Retry-After longer than the backoff', 'http_503' as const, 2, 2_000],
    ['a Retry-After clamped to 300s', 'http_429' as const, 1_000, 300_000],
  ])('%s sets when the step is claimable again', async (_, kind, seconds, waitMs) => {
    const { view } = await visitWith(
      [{ id: 'throttled', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind, params: { retryAfter: { form: 'seconds', seconds } } }],
      (v) => createVisit(v)?.state === 'retry_wait',
    );

    const [failed] = createVisit(view)?.attemptLog ?? [];
    expect(failed).toMatchObject({ attempt: 1, outcome: 'failed', httpStatus: kind === 'http_503' ? 503 : 429 });
    // A delta-seconds hint counts from when the answer arrived, a moment before the attempt ended; the 300s clamp from the end.
    const waited = Date.parse(createVisit(view)?.availableAt ?? '') - Date.parse(failed?.endedAt ?? '');
    expect(waited).toBeGreaterThan(waitMs - 100);
    expect(waited).toBeLessThanOrEqual(waitMs);
    expect(view.status).toBe('active');
  });

  it('a Retry-After date already past counts as absent: the backoff alone decides', async () => {
    const { view } = await visitWith(
      [{ id: 'throttled', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind: 'http_503', params: { retryAfter: { form: 'http-date', seconds: 0 } } }],
      (v) => createVisit(v)?.state === 'completed',
    );

    const [failed, completed] = createVisit(view)?.attemptLog ?? [];
    expect(failed).toMatchObject({ outcome: 'failed', httpStatus: 503 });
    // The first backoff is drawn from [0, 1s); the worker polls every 20ms.
    expect(Date.parse(completed?.startedAt ?? '') - Date.parse(failed?.endedAt ?? '')).toBeLessThan(1_200);
  });

  it('a permanent http_400 on a create dead-letters the step at once, PAYLOAD_INVALID, with no retry', async () => {
    const { visit, view, mock } = await visitWith(
      [{ id: 'rejected', match: { method: 'POST', resourceType: 'Encounter' }, firstN: 1, kind: 'http_400' }],
      (v) => v.status === 'dead_lettered',
    );

    expect(createVisit(view)).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'PAYLOAD_INVALID', attempts: 1, availableAt: null });
    expect(createVisit(view)?.attemptLog).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'dead_lettered', errorCode: 'PAYLOAD_INVALID', httpStatus: 400 }),
    ]);
    const creates = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'POST');
    expect(creates).toHaveLength(1);
  });

  it('a step whose every attempt fails transiently is dead-lettered RETRIES_EXHAUSTED at the cap', async () => {
    const { view } = await visitWith(
      [{ id: 'always-500', match: { method: 'POST', resourceType: 'Encounter' }, everyNth: 1, kind: 'http_500' }],
      (v) => v.status === 'dead_lettered',
      { RETRY_MAX_ATTEMPTS: '3', RETRY_BACKOFF_BASE_MS: '10' },
    );

    expect(createVisit(view)).toMatchObject({ state: 'dead_lettered', deadLetterReason: 'RETRIES_EXHAUSTED', attempts: 3 });
    expect(createVisit(view)?.attemptLog.map((a) => [a.attempt, a.outcome, a.errorCode, a.httpStatus])).toEqual([
      [1, 'failed', null, 500],
      [2, 'failed', null, 500],
      [3, 'failed', 'RETRIES_EXHAUSTED', 500],
    ]);
  });

  it('a read failing transiently is retried in-process, as sub-entries of the one attempt', async () => {
    const { visit, view, mock } = await visitWith(
      [{ id: 'search-503', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 2, kind: 'http_503' }],
      (v) => createVisit(v)?.state === 'completed',
    );

    expect(createVisit(view)?.attempts).toBe(1);
    const [only] = createVisit(view)?.attemptLog ?? [];
    expect(only).toMatchObject({ attempt: 1, outcome: 'completed' });
    expect(only?.readRetries).toEqual([
      { call: 'GET /fhir-r4/v1/Encounter', try: 1, failure: 'status', httpStatus: 503 },
      { call: 'GET /fhir-r4/v1/Encounter', try: 2, failure: 'status', httpStatus: 503 },
    ]);
    const searches = (await mock.client.log({ visitKey: visit.visitId, resourceType: 'Encounter' })).filter((e) => e.method === 'GET');
    expect(searches.map((e) => e.response.status)).toEqual([503, 503, 200]);
    // 100ms then 400ms, each ±20%.
    const gaps = searches.slice(1).map((e, i) => Date.parse(e.receivedAt) - Date.parse(searches[i]?.respondedAt ?? ''));
    expect(gaps[0]).toBeGreaterThanOrEqual(80);
    expect(gaps[0]).toBeLessThan(200);
    expect(gaps[1]).toBeGreaterThanOrEqual(320);
    expect(gaps[1]).toBeLessThan(560);
  });

  it('a read still failing on its third try ends the attempt transient; the next attempt starts over', async () => {
    const { view } = await visitWith(
      [{ id: 'search-503', match: { method: 'GET', resourceType: 'Encounter' }, firstN: 3, kind: 'http_503' }],
      (v) => createVisit(v)?.state === 'completed',
    );

    expect(createVisit(view)?.attemptLog.map((a) => [a.attempt, a.outcome, a.httpStatus, a.readRetries.length])).toEqual([
      [1, 'failed', 503, 2],
      [2, 'completed', 201, 0],
    ]);
  });

  it('no call starts with less than one call timeout left of the attempt budget: the attempt ends attempt_budget_exceeded', async () => {
    const { view, mock } = await visitWith(
      [{ id: 'slow-patient', match: { method: 'GET', resourceType: 'Patient' }, firstN: 1, kind: 'latency', params: { ms: 700 } }],
      (v) => createVisit(v)?.state === 'completed',
      { ATTEMPT_BUDGET_MS: '2500', SATUSEHAT_CALL_TIMEOUT_MS: '2000' },
    );

    expect(createVisit(view)?.attemptLog.map((a) => [a.attempt, a.outcome, a.errorCode])).toEqual([
      [1, 'attempt_budget_exceeded', null],
      [2, 'completed', null],
    ]);
    // The first attempt stopped before its practitioner lookup: one practitioner search, by the second attempt.
    const practitionerSearches = (await mock.client.logNdjson()).filter((e) => e.resourceType === 'Practitioner');
    expect(practitionerSearches).toHaveLength(1);
  });
});
