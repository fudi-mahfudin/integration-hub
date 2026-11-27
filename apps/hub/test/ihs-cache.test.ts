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

/** The world's `n`th patient; each test takes its own, so no test sees another's cache entry. */
function patient(n: number) {
  const found = world.patients[n];
  if (!found) throw new Error(`the world dataset needs a patient #${n}`);
  return found;
}

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

  it('a patient found by NIK is taken from the cache on the next visit, without a search', async () => {
    const p = patient(10);

    const first = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-10' } });
    const searchesBefore = (await mock.client.log()).filter((e) => e.method === 'GET' && e.resourceType === 'Patient').length;
    const second = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-10' } });
    const searchesAfter = (await mock.client.log()).filter((e) => e.method === 'GET' && e.resourceType === 'Patient').length;

    expect(first.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'remote' });
    expect(second.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: p.ihsNumber } });
    expect(second.steps[0]?.attemptLog[0]).toMatchObject({ lookupMethods: { patient: 'nik' }, lookupSources: { patient: 'cache' } });
    expect(searchesAfter).toBe(searchesBefore);
  });

  it('each request to a cache is counted by its result: a miss, then a hit', async () => {
    const p = patient(15);
    const before = await cacheRequests('ihs_patient');
    const practitionerBefore = await cacheRequests('ihs_practitioner');

    await startVisit({ patient: { nik: p.nik, mrn: 'MRN-15' } });
    await startVisit({ patient: { nik: p.nik, mrn: 'MRN-15' } });

    expect(await cacheRequests('ihs_patient')).toEqual({ ...before, miss: before.miss + 1, hit: before.hit + 1 });
    // The same physician both times: the second lookup at least is a hit.
    expect((await cacheRequests('ihs_practitioner')).hit).toBeGreaterThanOrEqual(practitionerBefore.hit + 1);
  });

  it("a patient found by mother's NIK or by name + birthDate + gender is searched for again on every visit", async () => {
    const p = patient(11);
    const byMotherNik = { motherNik: p.motherNik, birthDate: p.birthDate, mrn: 'MRN-11' };
    const byNameBirthDateGender = { name: p.name, birthDate: p.birthDate, gender: p.gender, mrn: 'MRN-11' };

    const views = [
      await startVisit({ patient: byMotherNik }),
      await startVisit({ patient: byMotherNik }),
      await startVisit({ patient: byNameBirthDateGender }),
      await startVisit({ patient: byNameBirthDateGender }),
    ];

    for (const view of views) {
      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: p.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'remote' });
    }
  });

  it('a NIK no one has is searched for again on every visit: not found is never cached', async () => {
    const patientSearches = async () => (await mock.client.log()).filter((e) => e.method === 'GET' && e.resourceType === 'Patient').length;

    await startVisit({ patient: { nik: UNKNOWN_NIK, mrn: 'MRN-X' } });
    const before = await patientSearches();
    const second = await startVisit({ patient: { nik: UNKNOWN_NIK, mrn: 'MRN-X' } });

    expect(second).toMatchObject({ status: 'dead_lettered', deadLetterReason: 'PATIENT_NOT_FOUND' });
    expect(await patientSearches()).toBe(before + 1);
  });

  it('a permanent rejection of the write deletes the entries its attempt used: the next visit searches again', async () => {
    const p = patient(12);
    await startVisit({ patient: { nik: p.nik, mrn: 'MRN-12' } });

    await failNextEncounterCreate('http_400');
    const rejected = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-12' } });
    const next = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-12' } });

    expect(rejected).toMatchObject({ status: 'dead_lettered', deadLetterReason: 'PAYLOAD_INVALID' });
    expect(rejected.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'cache' });
    expect(next.steps[0]?.attemptLog[0]?.lookupSources).toEqual({ patient: 'remote', practitioner: 'remote' });
  });

  it('a transient failure deletes nothing: the retry and the next visit still take the cached entry', async () => {
    const p = patient(13);
    await startVisit({ patient: { nik: p.nik, mrn: 'MRN-13' } });

    await failNextEncounterCreate('http_500');
    const retried = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-13' } });
    const next = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-13' } });

    expect(retried.steps[0]?.attemptLog.map((a) => [a.outcome, a.lookupSources.patient])).toEqual([
      ['failed', 'cache'],
      ['completed', 'cache'],
    ]);
    expect(next.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'cache' });
  });

  it('a replay searches past the cache and overwrites the entry', async () => {
    const p = patient(14);
    await failNextEncounterCreate('http_400');
    const rejected = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-14' } });
    // Cached again by another visit after the rejection deleted it.
    await startVisit({ patient: { nik: p.nik, mrn: 'MRN-14' } });

    const before = await cacheRequests('ihs_patient');
    const replayed = await replay(rejected);
    const after = await cacheRequests('ihs_patient');
    const next = await startVisit({ patient: { nik: p.nik, mrn: 'MRN-14' } });

    expect(replayed.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: p.ihsNumber } });
    expect(replayed.steps[0]?.attemptLog.at(-1)?.lookupSources).toEqual({ patient: 'remote', practitioner: 'remote' });
    expect(after).toEqual({ ...before, bypass: before.bypass + 1 });
    expect(next.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'cache' });
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

  async function deliveredTwice(p: { nik: string; ihsNumber: string }) {
    const views: CaseView[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted({ patient: { nik: p.nik, mrn: 'MRN-F' } }) });
      expect(res.status).toBe(202);
      views.push(await waitForCase(hub.baseUrl, res.headers.get('location'), createVisitSettled, { apiKey: WORLD_SOURCE_API_KEY }));
    }
    return views;
  }

  const patientErrors = async () => valueOf(await scrapeMetrics(worker.baseUrl), 'cache_requests_total', { cache: 'ihs_patient', result: 'error' });

  it('a Redis answering slower than 50ms is a miss: every visit is delivered, by a search', async () => {
    // Through the proxy at full speed, the second visit is a hit: the worker is connected.
    const warm = await deliveredTwice(patient(18));
    expect(warm[1]?.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'cache' });
    const p = patient(16);
    const before = await patientErrors();
    redis.slowDown(200);

    const views = await deliveredTwice(p);
    redis.slowDown(0);

    for (const view of views) {
      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: p.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'remote' });
    }
    expect(await patientErrors()).toBe(before + 2);
  });

  it('a Redis that is down is a miss: every visit is delivered, by a search', async () => {
    const p = patient(17);
    const before = await patientErrors();
    await redis.cut();

    const views = await deliveredTwice(p);

    for (const view of views) {
      expect(view.steps[0]).toMatchObject({ state: 'completed', pins: { patientIhsNumber: p.ihsNumber } });
      expect(view.steps[0]?.attemptLog[0]?.lookupSources).toMatchObject({ patient: 'remote' });
    }
    expect(await patientErrors()).toBe(before + 2);
  });
});
