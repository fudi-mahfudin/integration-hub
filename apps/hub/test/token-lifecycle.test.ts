import type { LogEntry } from '@integration-hub/mock-satusehat/client';
import { afterEach, describe, expect, it } from 'vitest';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { postEvent, waitForCase, type CaseView } from './support/events.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { bootMock, WORLD_SOURCE_API_KEY, worldEnv, worldVisitStarted, type BootedMock } from './support/satusehat.js';

const TOKEN_PATH = '/oauth2/v1/accesstoken';
const tokenRequests = (log: LogEntry[]) => log.filter((e) => e.path.startsWith(TOKEN_PATH));
const created = (v: CaseView) => v.steps[0]?.state === 'completed';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the access token: refreshed before it lapses, without hammering the throttled token endpoint (#13)', () => {
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

  /** A mock whose tokens last `tokenExpiresInSeconds`, a hub, and the environment of its workers. */
  async function boot(tokenExpiresInSeconds: number, env: Record<string, string> = {}) {
    mock = await bootMock({ tokenExpiresInSeconds });
    database = await createFreshDatabase();
    const fullEnv = { ...worldEnv(mock.baseUrl, database.url), ...env };
    hub = await bootHub(fullEnv);
    const booted = { mock, hub, env: fullEnv };
    return {
      ...booted,
      startWorker: async (workerEnv: Record<string, string> = {}) => {
        const worker = await bootWorker({ ...fullEnv, ...workerEnv });
        workers.push(worker);
        return worker;
      },
      /** Sends a fresh world visit; resolves to its case once `done` holds. */
      visit: async (done: (v: CaseView) => boolean, timeoutMs = 5_000) => {
        const res = await postEvent(booted.hub.baseUrl, { apiKey: WORLD_SOURCE_API_KEY, body: worldVisitStarted() });
        return waitForCase(booted.hub.baseUrl, res.headers.get('location'), done, { apiKey: WORLD_SOURCE_API_KEY, timeoutMs });
      },
    };
  }

  it('a revoked token: the 401 is cured by one refresh and a resend, consuming no attempt', async () => {
    const { mock, startWorker, visit } = await boot(3599, { SATUSEHAT_TOKEN_MIN_INTERVAL_MS: '0' });
    await startWorker();
    await visit(created);
    await mock.client.revokeTokens();

    const view = await visit(created);

    expect(view.steps[0]?.attempts).toBe(1);
    expect(view.steps[0]?.attemptLog).toEqual([expect.objectContaining({ outcome: 'completed', readRetries: [] })]);
    const log = await mock.client.logNdjson();
    expect(tokenRequests(log).map((e) => e.response.status)).toEqual([200, 200]);
    expect(log.filter((e) => e.response.status === 401)).toHaveLength(1);
  });

  it('is refreshed at 80% of expires_in, before it lapses: no call is answered 401', async () => {
    const { mock, startWorker, visit } = await boot(3, { SATUSEHAT_TOKEN_MIN_INTERVAL_MS: '0' });
    await startWorker();
    await visit(created);
    // Past 80% of 3s, still inside the token's life.
    await sleep(2_500);

    const view = await visit(created);

    expect(view.steps[0]?.attempts).toBe(1);
    const log = await mock.client.logNdjson();
    expect(tokenRequests(log)).toHaveLength(2);
    expect(log.filter((e) => e.response.status === 401)).toEqual([]);
  });

  it('is fetched at most once per 10s by a process, even when it lasts 3s; calls needing it meanwhile end transient', async () => {
    // Retries a second apart at most, and enough of them to outlast the 10s floor, so the step completes soon after it.
    const { mock, startWorker, visit } = await boot(3, { RETRY_BACKOFF_CAP_MS: '1000', RETRY_MAX_ATTEMPTS: '100' });
    await startWorker();
    await visit(created);
    await sleep(3_200);

    const view = await visit(created, 12_000);

    const [first, ...later] = view.steps[0]?.attemptLog ?? [];
    expect(first).toMatchObject({ outcome: 'failed', httpStatus: null });
    expect(later.at(-1)).toMatchObject({ outcome: 'completed' });
    const fetched = tokenRequests(await mock.client.logNdjson());
    expect(fetched).toHaveLength(2);
    expect(Date.parse(fetched[1]?.receivedAt ?? '') - Date.parse(fetched[0]?.receivedAt ?? '')).toBeGreaterThanOrEqual(10_000);
  }, 30_000);

  it('after a failed token request, every process stops asking for 60s: Redis holds the backoff', async () => {
    const { mock, startWorker, visit } = await boot(3599);
    await mock.client.setFaults({ seed: 35, rules: [{ id: 'token-down', match: { path: TOKEN_PATH }, firstN: 1, kind: 'http_500' }] });
    const first = await startWorker();
    const failedFirst = await visit((v) => (v.steps[0]?.attemptLog.length ?? 0) > 0);
    await first.close();
    workers.splice(workers.indexOf(first), 1);
    // A fresh process, with no token and no memory of the failure.
    await startWorker();

    const failedSecond = await visit((v) => (v.steps[0]?.attemptLog.length ?? 0) > 1);

    for (const view of [failedFirst, failedSecond]) {
      expect(view.status).toBe('active');
      expect(view.steps[0]?.attemptLog[0]).toMatchObject({ outcome: 'failed', errorCode: null, httpStatus: null });
    }
    const fetched = tokenRequests(await mock.client.logNdjson());
    expect(fetched.map((e) => e.response.status)).toEqual([500]);
  });

  it('without Redis, a process backs off on its own for 60s', async () => {
    const { mock, startWorker, visit } = await boot(3599);
    await mock.client.setFaults({ seed: 35, rules: [{ id: 'token-down', match: { path: TOKEN_PATH }, firstN: 1, kind: 'http_500' }] });
    // Nothing listens on port 1.
    await startWorker({ REDIS_URL: 'redis://127.0.0.1:1' });

    const view = await visit((v) => (v.steps[0]?.attemptLog.length ?? 0) > 2);

    expect(view.steps[0]?.attemptLog.every((a) => a.outcome === 'failed' && a.httpStatus === null)).toBe(true);
    const fetched = tokenRequests(await mock.client.logNdjson());
    expect(fetched.map((e) => e.response.status)).toEqual([500]);
  });
});
