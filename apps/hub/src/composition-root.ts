import 'reflect-metadata';
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
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
import { createDatabase } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { awaitSchema } from './db/schema-version.js';
import { HealthController } from './health/health.controller.js';
import { createReadiness } from './health/readiness.js';
import { createWorkerServer } from './health/worker-server.js';
import { MetricsController } from './health/metrics.controller.js';
import { Problem, ProblemFilter, sendProblem } from './http/problem.js';
import { EventsController } from './ingestion/events.controller.js';
import type { IdempotencyStore } from './ingestion/idempotency-store.js';
import { createIngest } from './ingestion/ingest.js';
import { createNaiveRedisIdempotencyStore } from './ingestion/naive-redis-idempotency-store.js';
import { createPostgresIdempotencyStore } from './ingestion/postgres-idempotency-store.js';
import { createIhsNumberCache } from './ihs-cache/ihs-number-cache.js';
import { createKfaClient } from './kfa/kfa-client.js';
import { loadDrugMappingSeed } from './mapping/drug-mappings.js';
import { loadLocationMappingSeed } from './mapping/location-mappings.js';
import { MappingsController } from './mapping/mappings.controller.js';
import { readDatabaseGauges } from './observability/database-gauges.js';
import { createLog, runInRequestContext, type Log, type LogDestination } from './observability/log.js';
import { createHubMetrics, createWorkerMetrics } from './observability/metrics.js';
import { nestLogger } from './observability/nest-logger.js';
import { nameServerSpan } from './observability/tracing.js';
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
import { ADMIN_KEY, CASES, CLOCK, DATABASE, INGEST, LOG, METRICS, READINESS, RECONCILIATION, SOURCE_SYSTEMS } from './tokens.js';

@Module({})
class HubServiceModule {
  static register(providers: Provider[]): DynamicModule {
    return {
      module: HubServiceModule,
      controllers: [HealthController, MetricsController, EventsController, CasesController, DeadLettersController, MappingsController, ReconciliationController],
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

/** A booted hub service that has connected to Postgres and Redis and found its schema version. */
export interface Hub {
  /** Starts listening and resolves to the base URL, e.g. `http://127.0.0.1:41234/`. */
  listen(): Promise<URL>;
  /** Runs the idempotency-key purge job now (it also runs on its timer); resolves to how many keys it deleted. */
  purgeIdempotencyKeys(): Promise<number>;
  /**
   * The graceful shutdown (#43). Readiness turns `draining`; after
   * `SHUTDOWN_DELAY_MS` the server stops accepting connections, and a request
   * arriving on a connection still open is refused `503 SERVICE_DRAINING`.
   * Requests in flight have 10s to finish before their connections are cut;
   * then the Postgres pool and Redis are closed. Every call resolves when the shutdown is done.
   */
  close(): Promise<void>;
}

/** How long requests in flight have to finish once the hub service drains (#43). */
const HUB_DRAIN_DEADLINE_MS = 10_000;

/** Paths a draining hub service still answers, so orchestrators and Prometheus see it drain. */
const OPERATIONS_PATHS = new Set(['/livez', '/readyz', '/metrics']);

/**
 * The production composition root of the hub service: `main.ts` and the test
 * harness both boot the hub through here and nowhere else. Fails fast if
 * Postgres or Redis is unreachable, so a hub that boots is wired to both.
 */
export async function createHub(config: HubConfig, runtime: HubRuntime): Promise<Hub> {
  const { clock } = runtime;
  const log = createLog('hub', runtime.logs);
  const db = createDatabase(config.databaseUrl, droppedConnectionLogger(log));
  let redis: Redis;
  try {
    await awaitSchema(db, hostOf(config.databaseUrl));
    redis = await connectRedis(config.redisUrl, log);
  } catch (err) {
    await db.destroy();
    throw err;
  }

  const store: IdempotencyStore =
    config.idempotencyStore === 'naive-redis'
      ? createNaiveRedisIdempotencyStore({ db, redis, retentionHours: config.idempotencyRetentionHours })
      : createPostgresIdempotencyStore({ db, clock, retentionHours: config.idempotencyRetentionHours });
  // The database-derived gauges are the hub service's alone, read at each scrape (#15).
  const metrics = createHubMetrics({ readDatabaseGauges: () => readDatabaseGauges(db, { now: clock(), stalledAfterMs: config.stalledAfterMs }) });
  const ingest = createIngest({ store, db, clock, log, metrics });
  const sources = new SourceSystems(config.sources);
  const readiness = createReadiness({ db, redis });

  const app = await NestFactory.create<NestFastifyApplication>(
    HubServiceModule.register([
      { provide: DATABASE, useValue: db },
      { provide: SOURCE_SYSTEMS, useValue: sources },
      { provide: ADMIN_KEY, useValue: new AdminKey(config.adminApiKey, sources) },
      { provide: CLOCK, useValue: clock },
      { provide: LOG, useValue: log },
      { provide: METRICS, useValue: metrics },
      { provide: CASES, useValue: createCases({ db, clock, stalledAfterMs: config.stalledAfterMs, metrics }) },
      { provide: INGEST, useValue: ingest },
      { provide: RECONCILIATION, useValue: createReconciliationRuns({ db, clock }) },
      { provide: READINESS, useValue: readiness },
    ]),
    // A UUID per request, so a `requestId` is unique across hub service processes. A draining
    // hub refuses requests with its own problem (#43), not Fastify's plain 503.
    new FastifyAdapter({ genReqId: () => randomUUID(), return503OnClosing: false }),
    { logger: nestLogger(log), bodyParser: false },
  );
  // Every line logged while handling a request carries its `requestId` (#40).
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (req, _reply, done) => {
    // A traced request's server span is named by its route template, never its raw path (#42).
    if (req.routeOptions.url !== undefined) nameServerSpan(req.method, req.routeOptions.url);
    runInRequestContext(req.id, done);
  });
  // Once draining, a request on a connection still open is refused (#43); it was never read, so resending it is safe.
  let refusing = false;
  fastify.addHook('onRequest', async (req, reply) => {
    if (!refusing || OPERATIONS_PATHS.has(req.routeOptions.url ?? '')) return;
    log('info', 'request refused: the hub service is draining', { errorCode: 'SERVICE_DRAINING', status: 503 });
    if (req.method === 'POST' && req.routeOptions.url === '/v1/events') {
      metrics.ingestRejected('SERVICE_DRAINING');
      metrics.ingestRequest('unknown', 503, 0);
    }
    return sendProblem(reply, new Problem('SERVICE_DRAINING', []));
  });
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

  let closing: Promise<void> | undefined;
  async function drain(): Promise<void> {
    readiness.drain();
    log('info', 'hub service draining', { shutdownDelayMs: config.shutdownDelayMs });
    clearInterval(purgeTimer);
    if (config.shutdownDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, config.shutdownDelayMs));
    refusing = true;
    const deadline = setTimeout(() => {
      log('warn', 'hub service drain deadline reached: open connections are cut');
      app.getHttpServer().closeAllConnections();
    }, HUB_DRAIN_DEADLINE_MS);
    // Stops accepting connections and closes the idle ones; resolves once the last open one has closed.
    await app.close();
    clearTimeout(deadline);
    await db.destroy();
    redis.disconnect();
    log('info', 'hub service drained');
  }

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
    close() {
      closing ??= drain();
      return closing;
    },
  };
}

/** A booted worker process that has connected to Postgres and found its schema version. */
export interface HubWorker {
  /** Starts serving `/livez`, `/readyz` and `/metrics` on `WORKER_PORT` and resolves to its base URL, e.g. `http://127.0.0.1:41235/`. */
  listen(): Promise<URL>;
  /**
   * Starts claiming steps and executing reconciliation runs once a readiness
   * check succeeds (#43), checking again every poll interval until one does.
   * Resolves once it claims (or once `close()` is called first).
   */
  start(): Promise<void>;
  /**
   * The graceful shutdown (#43). Readiness turns `draining` and the worker
   * stops claiming; the attempt in progress runs on until the drain deadline
   * (`WORKER_DRAIN_DEADLINE_MS`), at which it is aborted and its step
   * released as `worker_shutdown`. A reconciliation run in progress is
   * interrupted once no step lease is held, or at the deadline. Then the HTTP
   * server, the Postgres pool, the SATUSEHAT connections and Redis are closed.
   * A second call skips the rest of the drain to its deadline; every call
   * resolves when the shutdown is done.
   */
  close(): Promise<void>;
}

/**
 * The production composition root of the worker process (ADR 0001): the
 * worker entry point and the test harness both boot it through here. Loads
 * the location and drug mapping seeds, and fails fast if Postgres is unreachable.
 */
export async function createWorker(config: HubConfig, runtime: HubRuntime): Promise<HubWorker> {
  const { clock } = runtime;
  const log = createLog('worker', runtime.logs);
  const db = createDatabase(config.databaseUrl, droppedConnectionLogger(log));
  try {
    await awaitSchema(db, hostOf(config.databaseUrl));
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
  // Work metrics come from the process doing the work (#15); the breakers' states are read at each scrape.
  const metrics = createWorkerMetrics({ breakerStates: () => ({ fhir: breakers.fhir.state(), kfa: breakers.kfa.state(), auth: breakers.auth.state() }) });
  // One breaker per platform API, in this process's memory (#13).
  const breakerOf = (api: PlatformApi) => createCircuitBreaker({ api, clock, openMs: config.satusehat.breakerOpenMs, log, metrics });
  const breakers = { fhir: breakerOf('fhir'), kfa: breakerOf('kfa'), auth: breakerOf('auth') };
  const tokens = createAccessTokens({ config: config.satusehat, dispatcher, clock, shared, breaker: breakers.auth, metrics });
  const limiter = createRateLimiter({
    redis,
    clock,
    urls: { fhir: config.satusehat.fhirUrl, kfa: config.satusehat.kfaUrl },
    rps: config.satusehat.rateLimitRps,
    workerProcesses: config.workerProcesses,
    log,
    metrics,
  });
  const transport = createSatusehatTransport({
    tokens,
    breakers,
    limiter,
    dispatcher,
    callTimeoutMs: config.satusehat.callTimeoutMs,
    connectTimeoutMs: config.satusehat.connectTimeoutMs,
    clock,
    random: Math.random,
    metrics,
  });
  // Fails open (#47): a Redis that is down or slow is a miss, so the worker runs without it.
  const ihsCache = createIhsNumberCache({ redis, pepper: config.ihsCache.pepper, enabled: config.ihsCache.enabled, log, metrics });
  const clientsFor = (calls: AttemptCalls) => ({
    satusehat: createSatusehatClient({ config: config.satusehat, transport, calls }),
    kfa: createKfaClient({ config: config.satusehat, transport, calls }),
  });
  const worker = createWorkerLoop({
    outbox: createOutbox({ db, clock, leaseMs: config.workerLeaseMs, retry: config.retry, random: Math.random, metrics }),
    runners: {
      create_visit: (step, calls) => createVisit({ db, ...clientsFor(calls), ihsCache }, step),
      submit_prescription: (step, calls) => submitPrescription({ db, ...clientsFor(calls), clock, ihsCache }, step),
      submit_dispense: (step, calls) => submitDispense({ db, ...clientsFor(calls), clock, ihsCache }, step),
      update_visit: (step, calls) => updateVisit({ db, ...clientsFor(calls) }, step),
    },
    breakers: Object.values(breakers),
    pollIntervalMs: config.workerPollIntervalMs,
    attemptBudgetMs: config.attemptBudgetMs,
    ihsCache,
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
    metrics,
  });
  const readiness = createReadiness({ db, redis });
  const server = createWorkerServer({
    metrics,
    readiness: async () => ({
      ...(await readiness.check()),
      breakers: { fhir: breakers.fhir.state(), kfa: breakers.kfa.state(), auth: breakers.auth.state() },
      limiter: { mode: limiter.mode() },
    }),
    host: config.host,
    port: config.workerPort,
    log,
  });

  let closing: Promise<void> | undefined;
  let skipToDeadline = () => {};

  async function drain(): Promise<void> {
    readiness.drain();
    log('info', 'worker draining: it claims nothing more, and lets the attempt in progress end', { deadlineMs: config.workerDrainDeadlineMs });
    const attemptsEnded = worker.stop();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), config.workerDrainDeadlineMs);
      skipToDeadline = () => resolve('deadline');
    });
    if ((await Promise.race([attemptsEnded, deadline])) === 'deadline') {
      log('warn', 'drain deadline reached: the attempt in progress is aborted and its step released');
      worker.abort();
    }
    clearTimeout(timer);
    // No step lease is held from here on: a reconciliation run still going is interrupted.
    await Promise.all([attemptsEnded, reconciler.stop()]);
    await server.close();
    await db.destroy();
    await dispatcher.close();
    redis.disconnect();
    log('info', 'worker drained');
  }

  return {
    async listen() {
      const baseUrl = await server.listen();
      log('info', 'worker serving health and metrics', { url: baseUrl.href });
      return baseUrl;
    },
    async start() {
      let waiting = false;
      while (!closing) {
        if ((await readiness.check()).status === 'ready') break;
        if (!waiting) log('warn', 'worker not ready: it claims nothing until Postgres answers its readiness check');
        waiting = true;
        await new Promise((resolve) => setTimeout(resolve, config.workerPollIntervalMs));
      }
      // Told to close while it waited: it never claims.
      if (closing) return;
      worker.start();
      reconciler.start();
      log('info', 'worker claiming steps');
    },
    close() {
      if (closing) {
        skipToDeadline();
        return closing;
      }
      closing = drain();
      return closing;
    },
  };
}

/**
 * The composition root of the one-shot `migrate` command: opens Postgres,
 * applies pending migrations, and closes it again.
 */
export async function migrateDatabase(config: HubConfig): Promise<MigrationResult[]> {
  // A one-shot command: a dropped connection fails the query in progress, which fails the command.
  const db = createDatabase(config.databaseUrl, () => {});
  try {
    return await runMigrations(db);
  } finally {
    await db.destroy();
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

/** Logs a Postgres connection that was dropped; safe to carry on, as the pool opens a new one when next asked. */
function droppedConnectionLogger(log: Log): (err: Error) => void {
  return (err) => log('warn', 'a Postgres connection was dropped; the pool reconnects on its next query', { error: err });
}

/** Host and port only: connection URLs may carry a password. */
function hostOf(url: string): string {
  return new URL(url).host;
}
