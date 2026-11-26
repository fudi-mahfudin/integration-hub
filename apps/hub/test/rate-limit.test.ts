import type { LogEntry } from '@integration-hub/mock-satusehat/client';
import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitStarted, type BootedMock } from './support/satusehat.js';

/** The live-sandbox profile's FHIR rate (#13): 5 rps, with a burst of 1s worth. */
const FHIR_RPS = 5;
const FHIR_BURST = 5;

const fhirCalls = (log: LogEntry[]) => log.filter((e) => e.path.startsWith('/fhir-r4/'));

/**
 * The most calls in any stretch of the log beyond what a token bucket of
 * `rps` and `burst` allows over that stretch: positive means it was exceeded.
 */
function worstExcess(calls: LogEntry[], rps: number, burst: number): number {
  const at = calls.map((e) => Date.parse(e.receivedAt)).sort((a, b) => a - b);
  let worst = -Infinity;
  for (let i = 0; i < at.length; i++) {
    for (let j = i; j < at.length; j++) {
      const allowed = burst + (rps * ((at[j] ?? 0) - (at[i] ?? 0))) / 1000;
      worst = Math.max(worst, j - i + 1 - allowed);
    }
  }
  return worst;
}

describe('the shared rate limit per platform API (#36)', () => {
  let mock: BootedMock | undefined;
  let database: FreshDatabase | undefined;
  let hub: BootedHub | undefined;
  const workers: BootedWorker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
    await hub?.close();
    await database?.drop();
    await mock?.close();
    hub = database = mock = undefined;
  });

  /** Boots a mock, a hub and two workers with `workerEnv`; sends `visits` world visits and waits for each one's visit to be created. */
  async function deliver(visits: number, workerEnv: Record<string, string>) {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = { ...worldEnv(mock.baseUrl, database.url), SATUSEHAT_PROFILE: 'live-sandbox' };
    hub = await bootHub(env);
    for (let i = 0; i < 2; i++) workers.push(await bootWorker({ ...env, ...workerEnv }));
    const locations: (string | null)[] = [];
    for (let i = 0; i < visits; i++) {
      locations.push((await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted() })).headers.get('location'));
    }
    const { baseUrl } = hub;
    await Promise.all(
      locations.map((location) =>
        waitForCase(baseUrl, location, (v) => v.steps[0]?.state === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 20_000 }),
      ),
    );
    return fhirCalls(await mock.client.logNdjson());
  }

  it('two workers together stay within the FHIR rate, through Redis', async () => {
    const calls = await deliver(8, {});

    expect(calls.length).toBeGreaterThan(3 * FHIR_BURST);
    // One call of slack for timing between the hub's clock and the mock's receipt.
    expect(worstExcess(calls, FHIR_RPS, FHIR_BURST)).toBeLessThanOrEqual(1);
  }, 40_000);

  it('with Redis down, each worker falls back to its share of the rate, and the visits are still delivered', async () => {
    // Nothing listens on port 1; WORKER_PROCESSES is 2 by default.
    const calls = await deliver(8, { REDIS_URL: 'redis://127.0.0.1:1' });

    expect(calls.length).toBeGreaterThan(3 * FHIR_BURST);
    expect(worstExcess(calls, FHIR_RPS, FHIR_BURST)).toBeLessThanOrEqual(1);
  }, 40_000);

  it('a 429 holds off calls to its platform API until its Retry-After: the read retry waits for it', async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = worldEnv(mock.baseUrl, database.url);
    hub = await bootHub(env);
    await mock.client.setFaults({
      seed: 36,
      rules: [{ id: 'throttled', match: { method: 'GET', resourceType: 'Patient' }, firstN: 1, kind: 'http_429', params: { retryAfter: { form: 'seconds', seconds: 2 } } }],
    });
    workers.push(await bootWorker(env));
    const accepted = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted() });
    await waitForCase(hub.baseUrl, accepted.headers.get('location'), (v) => v.steps[0]?.state === 'completed', { apiKey: WORLD_SOURCE_API_KEY, timeoutMs: 10_000 });

    const calls = fhirCalls(await mock.client.logNdjson());
    const throttled = calls.findIndex((e) => e.fault === 'throttled');
    const [answered, next] = [calls[throttled], calls[throttled + 1]];
    expect(answered?.response.status).toBe(429);
    // The read retry alone would follow within 100ms ±20%.
    expect(Date.parse(next?.receivedAt ?? '') - Date.parse(answered?.respondedAt ?? '')).toBeGreaterThanOrEqual(1_900);
  });
});
