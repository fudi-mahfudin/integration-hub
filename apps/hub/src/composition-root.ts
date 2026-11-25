import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { SourceSystems } from './auth/source-systems.js';
import { CasesController } from './cases/cases.controller.js';
import type { HubConfig } from './config.js';
import { createDatabase, type Database } from './db/database.js';
import { HealthController } from './health/health.controller.js';
import { ProblemFilter } from './http/problem.js';
import { createIngest, type Ingest } from './ingestion/ingest.js';
import { EventsController } from './ingestion/events.controller.js';
import { loadMappingSeed, readMappingSeed } from './mapping/location-mappings.js';
import { createOutbox } from './outbox/outbox.js';
import { createFhirClient } from './satusehat/fhir-client.js';
import { createWorkerLoop } from './worker/worker.js';
import { CLOCK, CONFIG, DATABASE, INGEST, REDIS, SOURCE_SYSTEMS, type Clock } from './tokens.js';

export { DATABASE, REDIS } from './tokens.js';

interface Infrastructure {
  config: HubConfig;
  db: Kysely<Database>;
  redis: Redis;
  clock: Clock;
  ingest: Ingest;
}

@Module({})
class HubServiceModule {
  static register(infra: Infrastructure): DynamicModule {
    return {
      module: HubServiceModule,
      global: true,
      controllers: [HealthController, EventsController, CasesController],
      providers: [
        { provide: CONFIG, useValue: infra.config },
        { provide: DATABASE, useValue: infra.db },
        { provide: REDIS, useValue: infra.redis },
        { provide: CLOCK, useValue: infra.clock },
        { provide: SOURCE_SYSTEMS, useValue: new SourceSystems(infra.config.sources) },
        { provide: INGEST, useValue: infra.ingest },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [CONFIG, DATABASE, REDIS, CLOCK, SOURCE_SYSTEMS, INGEST],
    };
  }
}

export interface HubOptions {
  /** Defaults to the wall clock. Tests inject one to cross the key retention window. */
  clock?: Clock;
}

export interface Hub {
  /** Starts listening; resolves to the base URL, e.g. `http://127.0.0.1:41234`. */
  listen(): Promise<string>;
  /** Runs the idempotency-key purge now (it also runs on its own timer); resolves to keys deleted. */
  purgeIdempotencyKeys(): Promise<number>;
  close(): Promise<void>;
}

/**
 * The production composition root of the hub service: `main.ts` and the test
 * harness both boot the hub through here and nowhere else.
 */
export async function createHub(config: HubConfig, options: HubOptions = {}): Promise<Hub> {
  const db = createDatabase(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const clock = options.clock ?? (() => new Date());
  const ingest = createIngest({ config, db, redis, clock });
  // Operator mappings from the seed file, upserted idempotently on every boot (#10).
  try {
    await loadMappingSeed(db, readMappingSeed(config.mappingSeedPath), clock());
  } catch (err) {
    await db.destroy();
    throw err;
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    HubServiceModule.register({ config, db, redis, clock, ingest }),
    new FastifyAdapter(),
    { logger: ['error', 'warn'], bodyParser: false },
  );
  // Bodies reach controllers as raw text, whatever the content type: ingest
  // must authenticate and check the Idempotency-Key before judging the body,
  // and fingerprints the body itself (#7 check order).
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const purgeTimer =
    config.idempotencyPurgeIntervalMs > 0
      ? setInterval(() => {
          ingest.purgeExpiredKeys().catch((err: unknown) => console.error('idempotency purge failed', err));
        }, config.idempotencyPurgeIntervalMs).unref()
      : undefined;

  return {
    async listen() {
      await app.listen(config.port, config.host);
      const address = app.getHttpServer().address();
      if (address === null || typeof address === 'string') {
        throw new Error(`unexpected server address: ${String(address)}`);
      }
      return `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${address.port}`;
    },
    purgeIdempotencyKeys: () => ingest.purgeExpiredKeys(),
    async close() {
      clearInterval(purgeTimer);
      await app.close();
      await db.destroy();
      redis.disconnect();
    },
  };
}

export interface WorkerProcess {
  /** Starts claiming steps. */
  start(): void;
  /** Stops claiming, waits for attempts in progress, then disconnects. */
  close(): Promise<void>;
}

/**
 * The production composition root of the worker process (ADR 0001: same
 * codebase, second entry point). It serves no HTTP; it claims steps from the
 * Postgres outbox and runs them against SATUSEHAT.
 */
export async function createWorker(config: HubConfig, options: HubOptions = {}): Promise<WorkerProcess> {
  const db = createDatabase(config.databaseUrl);
  const clock = options.clock ?? (() => new Date());
  const loop = createWorkerLoop({
    config: config.worker,
    outbox: createOutbox({ db, clock, leaseMs: config.worker.leaseMs }),
    deps: { db, fhir: createFhirClient(config.satusehat, clock) },
    clock,
  });
  return {
    start: () => loop.start(),
    async close() {
      await loop.stop();
      await db.destroy();
    },
  };
}
