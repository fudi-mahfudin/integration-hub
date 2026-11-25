import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { HubConfig } from './config.js';
import { createDatabase, type Database } from './db/database.js';
import { HealthController } from './health/health.controller.js';

/** DI tokens for infrastructure built here and shared by every module. */
export const DATABASE = Symbol('DATABASE');
export const REDIS = Symbol('REDIS');

@Module({})
class HubServiceModule {
  static register(db: Kysely<Database>, redis: Redis): DynamicModule {
    return {
      module: HubServiceModule,
      global: true,
      controllers: [HealthController],
      providers: [
        { provide: DATABASE, useValue: db },
        { provide: REDIS, useValue: redis },
      ],
      exports: [DATABASE, REDIS],
    };
  }
}

export interface Hub {
  /** Starts listening; resolves to the base URL, e.g. `http://127.0.0.1:41234`. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

/**
 * The production composition root of the hub service: `main.ts` and the test
 * harness both boot the hub through here and nowhere else.
 */
export async function createHub(config: HubConfig): Promise<Hub> {
  const db = createDatabase(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

  const app = await NestFactory.create<NestFastifyApplication>(
    HubServiceModule.register(db, redis),
    new FastifyAdapter(),
    { logger: ['error', 'warn'] },
  );

  return {
    async listen() {
      await app.listen(config.port, config.host);
      const address = app.getHttpServer().address();
      if (address === null || typeof address === 'string') {
        throw new Error(`unexpected server address: ${String(address)}`);
      }
      return `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${address.port}`;
    },
    async close() {
      await app.close();
      await db.destroy();
      redis.disconnect();
    },
  };
}
