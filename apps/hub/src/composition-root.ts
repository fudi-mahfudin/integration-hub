import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import type { MigrationResult } from 'kysely/migration';
import type { HubConfig } from './config.js';
import { createDatabase, type Database } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { HealthController } from './health/health.controller.js';
import { log } from './observability/log.js';

@Module({ controllers: [HealthController] })
class HubServiceModule {}

/** A booted hub service that has connected to Postgres and Redis. */
export interface Hub {
  /** Starts listening and resolves to the base URL, e.g. `http://127.0.0.1:41234/`. */
  listen(): Promise<URL>;
  /** Stops the HTTP server, then closes the Postgres pool and the Redis connection. */
  close(): Promise<void>;
}

/**
 * The production composition root of the hub service: `main.ts` and the test
 * harness both boot the hub through here and nowhere else. Fails fast if
 * Postgres or Redis is unreachable, so a hub that boots is wired to both.
 */
export async function createHub(config: HubConfig): Promise<Hub> {
  const db = createDatabase(config.databaseUrl);
  let redis: Redis;
  try {
    await checkPostgres(db, config.databaseUrl);
    redis = await connectRedis(config.redisUrl);
  } catch (err) {
    await db.destroy();
    throw err;
  }

  const app = await NestFactory.create<NestFastifyApplication>(HubServiceModule, new FastifyAdapter(), {
    logger: ['error', 'warn'],
  });

  return {
    async listen() {
      await app.listen(config.port, config.host);
      const address = app.getHttpServer().address();
      if (address === null || typeof address === 'string') {
        throw new Error(`expected the server to listen on a TCP port, got address ${JSON.stringify(address)}`);
      }
      const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
      return new URL(`http://${host}:${address.port}/`);
    },
    async close() {
      await app.close();
      await db.destroy();
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

async function connectRedis(redisUrl: string): Promise<Redis> {
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

/** Host and port only: connection URLs may carry a password. */
function hostOf(url: string): string {
  return new URL(url).host;
}
