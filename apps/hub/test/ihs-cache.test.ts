import { loadConfig } from '../src/config.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { adminRequest, postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { scrapeMetrics, valueOf } from './support/metrics.js';
import { startTcpProxy, type TcpProxy } from './support/tcp-proxy.js';
import { bootMock, world, WORLD_SOURCE_API_KEY, worldEnv, worldVisitStarted, type BootedMock } from './support/satusehat.js';

/** A well-formed NIK no world patient or practitioner has. */
const UNKNOWN_NIK = '9271069999999998';

const createVisitSettled = (v: CaseView) => v.steps[0]?.state === 'completed' || v.steps[0]?.state === 'dead_lettered';

/** The world's `n`th practitioner; each test takes its own, so no test sees another's cache entry. */
function practitioner(n: number) {
  const found = world.practitioners[n];
  if (!found) throw new Error(`the world dataset needs a practitioner #${n}`);
  return found;
}

/** The world's `n`th patient. */
function patient(n: number) {
  const found = world.patients[n];
  if (!found) throw new Error(`the world dataset needs a patient #${n}`);
  return found;
}

/** The searches at SATUSEHAT for `resourceType` the mock has received. */
const searchesFor = async (mock: BootedMock, resourceType: 'Patient' | 'Practitioner') =>
  (await mock.client.log()).filter((e) => e.method === 'GET' && e.resourceType === resourceType).length;

describe('IHS-number cache: IHS numbers found by exact NIK lookup are cached (#47)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), RETRY_BACKOFF_BASE_MS: '10', RETRY_BACKOFF_CAP_MS: '50' };
    hub = await bootHub(env);
    worker = await bootWorker(env);
  });

  afterEach(async () => {
    await mock.client.setFaults({ seed: 47, rules: [] });
  });

  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await database?.drop();
    await mock?.close();
  });

  /** Sends `visit.started` for these people and resolves once create visit settled. */
  async function startVisit(people: { patient?: Record<string, unknown>; practitioner?: Record<string, unknown> }) {
    const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted(people) });
    expect(res.status).toBe(202);
    return waitForCase(hub.baseUrl, res.headers.get('location'), createVisitSettled, { apiKey: WORLD_SOURCE_API_KEY });
  }

  /** The worker's `cache_requests_total` for `cache`, by result. */
  async function cacheRequests(cache: string) {
    const samples = await scrapeMetrics(worker.baseUrl);
    const of = (result: string) => valueOf(samples, 'cache_requests_total', { cache, result });
    return { hit: of('hit'), miss: of('miss'), bypass: of('bypass'), error: of('error') };
  }

  /** The next Encounter POST answers `kind`. */
  const failNextEncounterCreate = (kind: 'http_400' | 'http_500') =>
    mock.client.setFaults({ seed: 47, rules: [{ id: `enc-${kind}`, match: { method: 'POST', resourceType: 'Encounter' }, kind, firstN: 1 }] });

  /** Replays a dead-lettered case and resolves once its create visit settled again. */
  async function replay(view: CaseView) {
    const res = await adminRequest(hub.baseUrl, 'POST', `v1/cases/${view.caseId}/replay`);
    expect(res.status).toBe(200);
    return waitForCase(hub.baseUrl, `/v1/cases/${view.caseId}`, (v) => v.replayCount === 1 && createVisitSettled(v), { apiKey: WORLD_SOURCE_API_KEY });
  }

  it('a practitioner found by NIK is taken from the cache on the next visit, without a search', async () => {
    const pr = practitioner(10);

    const first = await startVisit({ practitioner: { nik: pr.nik } });
    const searchesBefore = await searchesFor(mock, 'Practitioner');
    const second = await startVisit({ practitioner: { nik: pr.nik } });

    expect(first.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'remote' });
    expect(second.steps[0]).toMatchObject({ state: 'completed', pins: { practitionerIhsNumber: pr.ihsNumber } });
    expect(second.steps[0]?.attemptLog[0]).toMatchObject({ lookupMethods: { practitioner: 'nik' }, lookupSources: { practitioner: 'cache' } });
    expect(await searchesFor(mock, 'Practitioner')).toBe(searchesBefore);
  });

  it('each request to a cache is counted by its result: a miss, then a hit', async () => {
    const pr = practitioner(15);
    const before = await cacheRequests('ihs_practitioner');

    await startVisit({ practitioner: { nik: pr.nik } });
    await startVisit({ practitioner: { nik: pr.nik } });

    expect(await cacheRequests('ihs_practitioner')).toEqual({ ...before, miss: before.miss + 1, hit: before.hit + 1 });
  });

  it('a patient is searched for again on every visit, by NIK too: the patient cache missed the Cache run bar and was removed', async () => {
    const p = patient(10);

    await startVisit({ patient: { nik: p.nik, mrn: 'MRN-10' } });
    const before = await searchesFor(mock, 'Patient');
    const second = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-10' } });

    expect(second.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: p.ihsNumber } });
    expect(second.steps[0]?.attemptLog[0]).toMatchObject({ lookupMethods: { patient: 'nik' }, lookupSources: { patient: 'remote' } });
    expect(await searchesFor(mock, 'Patient')).toBe(before + 1);
  });

  it('no patient cache is ever asked: the only cache counted is the practitioner one', async () => {
    const p = patient(19);
    await startVisit({ patient: { nik: p.nik, mrn: 'MRN-19' } });

    const samples = await scrapeMetrics(worker.baseUrl);

    expect(samples.some((m) => m.name === 'cache_requests_total' && m.labels.cache === 'ihs_practitioner')).toBe(true);
    expect(samples.filter((m) => m.name === 'cache_requests_total' && m.labels.cache === 'ihs_patient')).toEqual([]);
  });

  it('a practitioner found by name + birthDate + gender is searched for again on every visit', async () => {
    const pr = practitioner(11);
    const byNameBirthDateGender = { name: pr.name, birthDate: pr.birthDate, gender: pr.gender };

    const views = [await startVisit({ practitioner: byNameBirthDateGender }), await startVisit({ practitioner: byNameBirthDateGender })];

    for (const view of views) {
      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { practitionerIhsNumber: pr.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'remote' });
    }
  });

  it('a NIK no one has is searched for again on every visit: not found is never cached', async () => {
    await startVisit({ practitioner: { nik: UNKNOWN_NIK } });
    const before = await searchesFor(mock, 'Practitioner');
    const second = await startVisit({ practitioner: { nik: UNKNOWN_NIK } });

    expect(second).toMatchObject({ status: 'dead_lettered', deadLetterReason: 'PRACTITIONER_NOT_FOUND' });
    expect(await searchesFor(mock, 'Practitioner')).toBe(before + 1);
  });

  it('a permanent rejection of the write deletes the entries its attempt used: the next visit searches again', async () => {
    const pr = practitioner(12);
    await startVisit({ practitioner: { nik: pr.nik } });

    await failNextEncounterCreate('http_400');
    const rejected = await startVisit({ practitioner: { nik: pr.nik } });
    const next = await startVisit({ practitioner: { nik: pr.nik } });

    expect(rejected).toMatchObject({ status: 'dead_lettered', deadLetterReason: 'PAYLOAD_INVALID' });
    expect(rejected.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'cache' });
    expect(next.steps[0]?.attemptLog[0]?.lookupSources).toEqual({ patient: 'remote', practitioner: 'remote' });
  });

  it('a transient failure deletes nothing: the retry and the next visit still take the cached entry', async () => {
    const pr = practitioner(13);
    await startVisit({ practitioner: { nik: pr.nik } });

    await failNextEncounterCreate('http_500');
    const retried = await startVisit({ practitioner: { nik: pr.nik } });
    const next = await startVisit({ practitioner: { nik: pr.nik } });

    expect(retried.steps[0]?.attemptLog.map((a) => [a.outcome, a.lookupSources.practitioner])).toEqual([
      ['failed', 'cache'],
      ['completed', 'cache'],
    ]);
    expect(next.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'cache' });
  });

  it('a replay searches past the cache and overwrites the entry', async () => {
    const pr = practitioner(14);
    await failNextEncounterCreate('http_400');
    const rejected = await startVisit({ practitioner: { nik: pr.nik } });
    // Cached again by another visit after the rejection deleted it.
    await startVisit({ practitioner: { nik: pr.nik } });

    const before = await cacheRequests('ihs_practitioner');
    const replayed = await replay(rejected);
    const after = await cacheRequests('ihs_practitioner');
    const next = await startVisit({ practitioner: { nik: pr.nik } });

    expect(replayed.steps[0]).toMatchObject({ state: 'completed', pins: { practitionerIhsNumber: pr.ihsNumber } });
    expect(replayed.steps[0]?.attemptLog.at(-1)?.lookupSources).toEqual({ patient: 'remote', practitioner: 'remote' });
    expect(after).toEqual({ ...before, bypass: before.bypass + 1 });
    expect(next.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'cache' });
  });
});

describe('IHS_CACHES: the caches on (#47)', () => {
  const env = (caches: string) => ({ ...worldEnv(new URL('http://mock.invalid/'), 'postgres://db.invalid/hub'), IHS_CACHES: caches });

  it('is the practitioner cache by default, and none turns it off', () => {
    const { IHS_CACHES: _, ...unset } = env('');
    expect(loadConfig(unset).ihsCache.enabled).toBe(true);
    expect(loadConfig(env('ihs_practitioner')).ihsCache.enabled).toBe(true);
    expect(loadConfig(env('none')).ihsCache.enabled).toBe(false);
  });

  it('refuses anything else, naming the variable', () => {
    expect(() => loadConfig(env('ihs_practitioner,ihs_practitioner'))).toThrow('IHS_CACHES must be "ihs_practitioner" or "none"');
  });

  it('refuses ihs_patient, naming why it was removed', () => {
    expect(() => loadConfig(env('ihs_patient,ihs_practitioner'))).toThrow('ihs_patient was removed: it missed the Cache run bar (results/cache/2026-11-28-d0550b0)');
  });
});

describe('IHS-number cache: fails open, so a Redis that is down or slow only costs a search (#47)', () => {
  let mock: BootedMock;
  let database: FreshDatabase;
  let hub: BootedHub;
  let worker: BootedWorker;
  let redis: TcpProxy;

  beforeAll(async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    redis = await startTcpProxy(loadConfig(process.env).redisUrl);
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    // Only the worker reaches Redis through the proxy: the hub service needs Redis to boot.
    worker = await bootWorker({ ...env, REDIS_URL: redis.url });
  });

  afterAll(async () => {
    await worker?.close();
    await hub?.close();
    await redis?.cut();
    await database?.drop();
    await mock?.close();
  });

  async function deliveredTwice(pr: { nik: string; ihsNumber: string }) {
    const views: CaseView[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted({ practitioner: { nik: pr.nik } }) });
      expect(res.status).toBe(202);
      views.push(await waitForCase(hub.baseUrl, res.headers.get('location'), createVisitSettled, { apiKey: WORLD_SOURCE_API_KEY }));
    }
    return views;
  }

  const practitionerErrors = async () => valueOf(await scrapeMetrics(worker.baseUrl), 'cache_requests_total', { cache: 'ihs_practitioner', result: 'error' });

  it('a Redis answering slower than 50ms is a miss: every visit is delivered, by a search', async () => {
    // Through the proxy at full speed, the second visit is a hit: the worker is connected.
    const warm = await deliveredTwice(practitioner(18));
    expect(warm[1]?.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'cache' });
    const pr = practitioner(16);
    const before = await practitionerErrors();
    redis.slowDown(200);

    const views = await deliveredTwice(pr);
    redis.slowDown(0);

    for (const view of views) {
      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { practitionerIhsNumber: pr.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'remote' });
    }
    expect(await practitionerErrors()).toBe(before + 2);
  });

  it('a Redis that is down is a miss: every visit is delivered, by a search', async () => {
    const pr = practitioner(17);
    const before = await practitionerErrors();
    await redis.cut();

    const views = await deliveredTwice(pr);

    for (const view of views) {
      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { practitionerIhsNumber: pr.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ practitioner: 'remote' });
    }
    expect(await practitionerErrors()).toBe(before + 2);
  });
});
