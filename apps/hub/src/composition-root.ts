import 'reflect-metadata';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import type { MigrationResult } from 'kysely/migration';
import { AdminKey } from './auth/admin-key.js';
import { SourceSystems } from './auth/source-systems.js';
import { CasesController } from './cases/cases.controller.js';
import { createCases } from './cases/cases.js';
import { DeadLettersController } from './cases/dead-letters.controller.js';
import type { Clock } from './clock.js';
import type { HubConfig } from './config.js';
import { createDatabase, type Database } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { HealthController } from './health/health.controller.js';
import { ProblemFilter } from './http/problem.js';
import { EventsController } from './ingestion/events.controller.js';
import type { IdempotencyStore } from './ingestion/idempotency-store.js';
import { createIngest } from './ingestion/ingest.js';
import { createNaiveRedisIdempotencyStore } from './ingestion/naive-redis-idempotency-store.js';
import { createPostgresIdempotencyStore } from './ingestion/postgres-idempotency-store.js';
import { createKfaClient } from './kfa/kfa-client.js';
import { loadDrugMappingSeed } from './mapping/drug-mappings.js';
import { loadLocationMappingSeed } from './mapping/location-mappings.js';
import { MappingsController } from './mapping/mappings.controller.js';
import { createLog, runInRequestContext, type Log, type LogDestination } from './observability/log.js';
import { nestLogger } from './observability/nest-logger.js';
import { createOutbox } from './outbox/outbox.js';
import { createCircuitBreaker, type PlatformApi } from './satusehat/circuit-breaker.js';
import { createSatusehatClient } from './satusehat/client.js';
import { createReconciler } from './reconciliation/reconciler.js';
import { ReconciliationController } from './reconciliation/reconciliation.controller.js';
import { createReconciliationRuns } from './reconciliation/runs.js';
import { createRateLimiter } from './satusehat/rate-limiter.js';
import { createAccessTokens } from './satusehat/token.js';
import { createRedisTokenBackoff } from './satusehat/token-backoff.js';
import { createSatusehatTransport, type AttemptCalls } from './satusehat/transport.js';
import { createVisit } from './steps/create-visit.js';
import { submitDispense } from './steps/submit-dispense.js';
import { submitPrescription } from './steps/submit-prescription.js';
import { updateVisit } from './steps/update-visit.js';
import { createWorkerLoop } from './worker/worker.js';
import { ADMIN_KEY, CASES, CLOCK, DATABASE, INGEST, LOG, RECONCILIATION, SOURCE_SYSTEMS } from './tokens.js';

@Module({})
class HubServiceModule {
  static register(providers: Provider[]): DynamicModule {
    return {
      module: HubServiceModule,
      controllers: [HealthController, EventsController, CasesController, DeadLettersController, MappingsController, ReconciliationController],
      providers: [...providers, { provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}

/** What the hub takes from its runtime besides configuration. */
export interface HubRuntime {
  /** "Now" for the hub: the wall clock in production; tests move it to cross the key retention window. */
  clock: Clock;
  /** Where the process's log lines go: stdout in production; the canary test captures them (#40). */
  logs: LogDestination;
}

/** A booted hub service that has connected to Postgres and Redis. */
export interface Hub {
  /** Starts listening and resolves to the base URL, e.g. `http://127.0.0.1:41234/`. */
  listen(): Promise<URL>;
  /** Runs the idempotency-key purge job now (it also runs on its timer); resolves to how many keys it deleted. */
  purgeIdempotencyKeys(): Promise<number>;
  /** Stops the purge timer and the HTTP server, then closes the Postgres pool and the Redis connection. */
  close(): Promise<void>;
}

/**
 * The production composition root of the hub service: `main.ts` and the test
 * harness both boot the hub through here and nowhere else. Fails fast if
 * Postgres or Redis is unreachable, so a hub that boots is wired to both.
 */
export async function createHub(config: HubConfig, runtime: HubRuntime): Promise<Hub> {
  const db = createDatabase(config.databaseUrl);
  const { clock } = runtime;
  const log = createLog('hub', runtime.logs);
  let redis: Redis;
  try {
    await checkPostgres(db, config.databaseUrl);
    redis = await connectRedis(config.redisUrl, log);
  } catch (err) {
    await db.destroy();
    throw err;
  }

  const store: IdempotencyStore =
    config.idempotencyStore === 'naive-redis'
      ? createNaiveRedisIdempotencyStore({ db, redis, retentionHours: config.idempotencyRetentionHours })
      : createPostgresIdempotencyStore({ db, clock, retentionHours: config.idempotencyRetentionHours });
  const ingest = createIngest({ store, db, clock, log });
  const sources = new SourceSystems(config.sources);

  const app = await NestFactory.create<NestFastifyApplication>(
    HubServiceModule.register([
      { provide: DATABASE, useValue: db },
      { provide: SOURCE_SYSTEMS, useValue: sources },
      { provide: ADMIN_KEY, useValue: new AdminKey(config.adminApiKey, sources) },
      { provide: CLOCK, useValue: clock },
      { provide: LOG, useValue: log },
      { provide: CASES, useValue: createCases({ db, clock, stalledAfterMs: config.stalledAfterMs }) },
      { provide: INGEST, useValue: ingest },
      { provide: RECONCILIATION, useValue: createReconciliationRuns({ db, clock }) },
    ]),
    // A UUID per request, so a `requestId` is unique across hub service processes.
    new FastifyAdapter({ genReqId: () => randomUUID() }),
    { logger: nestLogger(log), bodyParser: false },
  );
  // Every line logged while handling a request carries its `requestId` (#40).
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (req, _reply, done) => runInRequestContext(req.id, done));
  // Every body reaches controllers as raw text, whatever its content type:
  // ingest authenticates and checks the Idempotency-Key before it judges the
  // body, and fingerprints the body itself (#7 check order).
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const purgeIdempotencyKeys = async (): Promise<number> => {
    const deleted = await ingest.purgeExpiredKeys();
    log('info', 'idempotency keys purged', { deleted });
    return deleted;
  };
  const purgeTimer =
    config.idempotencyPurgeIntervalMs > 0
      ? setInterval(() => {
          // The next tick retries; a missed purge only keeps keys longer than the minimum window.
          purgeIdempotencyKeys().catch((err: unknown) => log('error', 'idempotency key purge failed', { error: err }));
        }, config.idempotencyPurgeIntervalMs).unref()
      : undefined;

  return {
    async listen() {
      await app.listen(config.port, config.host);
      const address = app.getHttpServer().address();
      if (address === null || typeof address === 'string') {
        throw new Error(`expected the server to listen on a TCP port, got address ${JSON.stringify(address)}`);
      }
      const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
      const baseUrl = new URL(`http://${host}:${address.port}/`);
      log('info', 'hub service listening', { url: baseUrl.href });
      return baseUrl;
    },
    purgeIdempotencyKeys,
    async close() {
      clearInterval(purgeTimer);
      await app.close();
      await db.destroy();
      redis.disconnect();
    },
  };
}

/** A booted worker process that has connected to Postgres. */
export interface HubWorker {
  /** Starts claiming steps, and executing reconciliation runs. */
  start(): void;
  /** Stops claiming and reconciling, waits for the attempt and the case check in progress, then closes the Postgres pool, the SATUSEHAT connections and Redis. */
  close(): Promise<void>;
}

/**
 * The production composition root of the worker process (ADR 0001): the
 * worker entry point and the test harness both boot it through here. Loads
 * the location and drug mapping seeds, and fails fast if Postgres is unreachable.
 */
export async function createWorker(config: HubConfig, runtime: HubRuntime): Promise<HubWorker> {
  const db = createDatabase(config.databaseUrl);
  const { clock } = runtime;
  const log = createLog('worker', runtime.logs);
  try {
    await checkPostgres(db, config.databaseUrl);
    await loadLocationMappingSeed(db, clock());
    await loadDrugMappingSeed(db, clock());
  } catch (err) {
    await db.destroy();
    throw err;
  }

  // One connection pool per process, with the connect timeout (#13).
  const dispatcher = new Agent({ connect: { timeout: config.satusehat.connectTimeoutMs } });
  // KFA v2 takes the same access token as FHIR (#14), so both share the process's tokens.
  // Redis only shares the token backoff and the rate limit; the worker runs without it (#13).
  const redis = connectOptionalRedis(config.redisUrl, log);
  const shared = createRedisTokenBackoff({ redis, authUrl: config.satusehat.authUrl, clock, log });
  // One breaker per platform API, in this process's memory (#13).
  const breakerOf = (api: PlatformApi) => createCircuitBreaker({ api, clock, openMs: config.satusehat.breakerOpenMs, log });
  const breakers = { fhir: breakerOf('fhir'), kfa: breakerOf('kfa'), auth: breakerOf('auth') };
  const tokens = createAccessTokens({ config: config.satusehat, dispatcher, clock, shared, breaker: breakers.auth });
  const transport = createSatusehatTransport({
    tokens,
    breakers,
    limiter: createRateLimiter({
      redis,
      clock,
      urls: { fhir: config.satusehat.fhirUrl, kfa: config.satusehat.kfaUrl },
      rps: config.satusehat.rateLimitRps,
      workerProcesses: config.workerProcesses,
      log,
    }),
    dispatcher,
    callTimeoutMs: config.satusehat.callTimeoutMs,
    connectTimeoutMs: config.satusehat.connectTimeoutMs,
    clock,
    random: Math.random,
  });
  const clientsFor = (calls: AttemptCalls) => ({
    satusehat: createSatusehatClient({ config: config.satusehat, transport, calls }),
    kfa: createKfaClient({ config: config.satusehat, transport, calls }),
  });
  const worker = createWorkerLoop({
    outbox: createOutbox({ db, clock, leaseMs: config.workerLeaseMs, retry: config.retry, random: Math.random }),
    runners: {
      create_visit: (step, calls) => createVisit({ db, ...clientsFor(calls) }, step),
      submit_prescription: (step, calls) => submitPrescription({ db, ...clientsFor(calls), clock }, step),
      submit_dispense: (step, calls) => submitDispense({ db, ...clientsFor(calls), clock }, step),
      update_visit: (step, calls) => updateVisit({ db, ...clientsFor(calls) }, step),
    },
    breakers: Object.values(breakers),
    pollIntervalMs: config.workerPollIntervalMs,
    attemptBudgetMs: config.attemptBudgetMs,
    log,
  });
  // Reconciliation shares the transport, so its searches keep to the same rate limit and breakers (#39).
  const reconciler = createReconciler({
    db,
    clock,
    satusehatFor: (calls) => clientsFor(calls).satusehat,
    intervalMs: config.reconciliation.intervalMs,
    lookbackMs: config.reconciliation.lookbackMs,
    pollIntervalMs: config.workerPollIntervalMs,
    checkBudgetMs: config.attemptBudgetMs,
    log,
  });

  return {
    start() {
      worker.start();
      reconciler.start();
      log('info', 'worker claiming steps');
    },
    async close() {
      await Promise.all([worker.stop(), reconciler.stop()]);
      await db.destroy();
      await dispatcher.close();
      redis.disconnect();
    },
  };
}

/**
 * The composition root of the one-shot `migrate` command: opens Postgres,
 * applies pending migrations, and closes it again.
 */
export async function migrateDatabase(config: HubConfig): Promise<MigrationResult[]> {
  const db = createDatabase(config.databaseUrl);
  try {
    return await runMigrations(db);
  } finally {
    await db.destroy();
  }
}

async function checkPostgres(db: Kysely<Database>, databaseUrl: string): Promise<void> {
  try {
    await sql`select 1`.execute(db);
  } catch (err) {
    throw new Error(`Postgres is not reachable at ${hostOf(databaseUrl)}; run \`pnpm deps:up\``, { cause: err });
  }
}

async function connectRedis(redisUrl: string, log: Log): Promise<Redis> {
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  // ioredis emits every socket error; log them as structured lines instead of its raw console output.
  redis.on('error', (err: Error) => log('warn', 'redis connection error', { error: err }));
  try {
    await redis.connect();
    return redis;
  } catch (err) {
    redis.disconnect();
    throw new Error(`Redis is not reachable at ${hostOf(redisUrl)}; run \`pnpm deps:up\``, { cause: err });
  }
}

/**
 * A Redis connection the process can run without: it connects in the
 * background and keeps reconnecting, and commands fail at once while it is
 * down instead of queueing, so their callers fall back.
 */
function connectOptionalRedis(redisUrl: string, log: Log): Redis {
  const redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  redis.on('error', (err: Error) => log('warn', 'redis connection error', { error: err }));
  redis.connect().catch((err: unknown) => {
    // Safe: callers fall back while it is down, and ioredis keeps reconnecting.
    log('warn', `Redis is not reachable at ${hostOf(redisUrl)}; the worker runs without it until it is`, { error: err });
  });
  return redis;
}

/** Host and port only: connection URLs may carry a password. */
function hostOf(url: string): string {
  return new URL(url).host;
}
