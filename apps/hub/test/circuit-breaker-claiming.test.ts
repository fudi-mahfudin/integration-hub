import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { postEvent, waitForCase } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitStarted, type BootedMock } from './support/satusehat.js';
import { spawnWorker, type SpawnedWorker } from './support/spawn-worker.js';

/** Short, so the test waits about two seconds for the breaker to go half-open; 30s in production. */
const OPEN_MS = 2_000;

/** Resolves to the first line `worker` logged that `matches`, polling until `timeoutMs`. */
async function loggedLine(worker: SpawnedWorker, matches: (line: Record<string, unknown>) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = worker.logged().find(matches);
    if (line) return line;
    if (Date.now() > deadline) throw new Error(`no matching log line within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the circuit breaker stops a worker claiming while its platform API is down (#36)', () => {
  let mock: BootedMock | undefined;
  let database: FreshDatabase | undefined;
  let hub: BootedHub | undefined;
  let worker: SpawnedWorker | undefined;

  afterEach(async () => {
    await worker?.stop();
    await hub?.close();
    await database?.drop();
    await mock?.close();
    worker = hub = database = mock = undefined;
  });

  it('a 5xx storm opens the FHIR breaker and claiming stops; once the platform is back, the probe closes it and the step completes', async () => {
    mock = await bootMock();
    database = await createFreshDatabase();
    const env = {
      ...worldEnv(mock.baseUrl, database.url),
      SATUSEHAT_BREAKER_OPEN_MS: String(OPEN_MS),
      // Without the breaker, the next attempt would follow within ~50ms.
      RETRY_BACKOFF_BASE_MS: '10',
      RETRY_BACKOFF_CAP_MS: '50',
      RETRY_MAX_ATTEMPTS: '100',
    };
    hub = await bootHub(env);
    // Every read fails; the token request (a POST) does not.
    await mock.client.setFaults({ seed: 36, rules: [{ id: 'reads-down', match: { method: 'GET' }, everyNth: 1, kind: 'http_500' }] });
    worker = await spawnWorker(env);
    const accepted = await postEvent(hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted() });

    const opened = await loggedLine(worker, (l) => String(l.message).startsWith('circuit breaker opened') && l.api === 'fhir', 10_000);
    await mock.client.setFaults({ seed: 36, rules: [] });
    const view = await waitForCase(hub.baseUrl, accepted.headers.get('location'), (v) => v.steps[0]?.state === 'completed', {
      apiKey: WORLD_SOURCE_API_KEY,
      timeoutMs: 10_000,
    });

    const openedAt = Date.parse(String(opened.time));
    const attempts = view.steps[0]?.attemptLog ?? [];
    const afterOpening = attempts.filter((a) => Date.parse(a.startedAt) > openedAt);
    const opening = attempts[attempts.length - afterOpening.length - 1];
    // The attempt that met the open breaker mid-attempt ended transient.
    expect(opening).toMatchObject({ outcome: 'failed' });
    // Nothing was claimed while it was open: the next attempt is the probe's, once it went half-open.
    expect(afterOpening).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    expect(Date.parse(afterOpening[0]?.startedAt ?? '') - openedAt).toBeGreaterThanOrEqual(OPEN_MS - 10);
    await loggedLine(worker, (l) => String(l.message).startsWith('circuit breaker closed') && l.api === 'fhir', 1_000);
  }, 30_000);
});
