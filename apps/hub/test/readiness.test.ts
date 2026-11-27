import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { bootHub, type BootedHub } from './support/boot-hub.js';
import { bootWorker, type BootedWorker } from './support/boot-worker.js';
import { createFreshDatabase, type FreshDatabase } from './support/fresh-database.js';
import { startTcpProxy, type TcpProxy } from './support/tcp-proxy.js';

const base = loadConfig(process.env);

/** `GET /readyz`: its status and body. */
async function readyz(baseUrl: URL): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL('readyz', baseUrl));
  return { status: res.status, body: await res.json() };
}

describe('hub service readiness (#43)', () => {
  let hub: BootedHub | undefined;
  const proxies: TcpProxy[] = [];

  afterEach(async () => {
    await hub?.close();
    hub = undefined;
    await Promise.all(proxies.splice(0).map((p) => p.cut()));
  });

  it('is ready with Postgres and Redis up, Redis reported as not gating', async () => {
    hub = await bootHub();

    const { status, body } = await readyz(hub.baseUrl);

    expect(status).toBe(200);
    expect(body).toEqual({
      status: 'ready',
      checks: { postgres: { status: 'up', latencyMs: expect.any(Number) }, redis: { status: 'up', gating: false } },
    });
  });

  it('answers 503 not_ready once Postgres is unreachable; /livez still answers 200', async () => {
    const postgres = await startTcpProxy(base.databaseUrl);
    proxies.push(postgres);
    hub = await bootHub({ DATABASE_URL: postgres.url });

    await postgres.cut();
    const { status, body } = await readyz(hub.baseUrl);

    expect(status).toBe(503);
    expect(body).toMatchObject({ status: 'not_ready', checks: { postgres: { status: 'down' }, redis: { status: 'up', gating: false } } });
    expect((await fetch(new URL('livez', hub.baseUrl))).status).toBe(200);
  });

  it('stays ready (200) once Redis is unreachable, with Redis reported down', async () => {
    const redis = await startTcpProxy(base.redisUrl);
    proxies.push(redis);
    hub = await bootHub({ REDIS_URL: redis.url });

    await redis.cut();
    const { status, body } = await readyz(hub.baseUrl);

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', checks: { postgres: { status: 'up' }, redis: { status: 'down', gating: false } } });
  });
});

describe('worker readiness (#43)', () => {
  let worker: BootedWorker | undefined;
  let database: FreshDatabase | undefined;
  const proxies: TcpProxy[] = [];

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await Promise.all(proxies.splice(0).map((p) => p.cut()));
    await database?.drop();
    database = undefined;
  });

  it('is ready with Postgres up, and shows each breaker and the limiter mode; /livez answers 200', async () => {
    database = await createFreshDatabase();
    worker = await bootWorker({ DATABASE_URL: database.url });
    const { baseUrl } = worker;
    // Redis connects in the background (the worker runs without it), so wait until it has.
    await eventually(async () => redisStatusOf((await readyz(baseUrl)).body) === 'up');

    const { status, body } = await readyz(worker.baseUrl);

    expect(status).toBe(200);
    expect(body).toEqual({
      status: 'ready',
      checks: { postgres: { status: 'up', latencyMs: expect.any(Number) }, redis: { status: 'up', gating: false } },
      breakers: { fhir: 'closed', kfa: 'closed', auth: 'closed' },
      limiter: { mode: 'redis' },
    });
    expect((await fetch(new URL('livez', worker.baseUrl))).status).toBe(200);
  });

  it('answers 503 once Postgres is unreachable', async () => {
    database = await createFreshDatabase();
    const postgres = await startTcpProxy(database.url);
    proxies.push(postgres);
    worker = await bootWorker({ DATABASE_URL: postgres.url });

    await postgres.cut();
    const { status, body } = await readyz(worker.baseUrl);

    expect(status).toBe(503);
    expect(body).toMatchObject({ status: 'not_ready', checks: { postgres: { status: 'down' } } });
  });

  it('stays ready once Redis is unreachable, with Redis down and the limiter on its local fallback', async () => {
    database = await createFreshDatabase();
    const redis = await startTcpProxy(base.redisUrl);
    proxies.push(redis);
    worker = await bootWorker({ DATABASE_URL: database.url, REDIS_URL: redis.url });
    const { baseUrl } = worker;
    // Redis connects in the background (the worker runs without it), so wait until it has.
    await eventually(async () => redisStatusOf((await readyz(baseUrl)).body) === 'up');

    await redis.cut();
    const { status, body } = await readyz(worker.baseUrl);

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', checks: { redis: { status: 'down', gating: false } }, limiter: { mode: 'local_fallback' } });
  });
});

/** The Redis status a readiness body reports. */
const redisStatusOf = (body: unknown) => z.object({ checks: z.object({ redis: z.object({ status: z.string() }) }) }).parse(body).checks.redis.status;

/** Polls `holds` every 50ms until it resolves to true. Fails after 5s. */
async function eventually(holds: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await holds()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the condition did not hold within 5s');
}
