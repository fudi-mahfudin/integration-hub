import { Redis } from 'ioredis';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';

// The hub never migrates itself, so the suite runs the same step the
// one-shot `migrate` command runs, once, before any hub boots. That also
// proves Postgres is reachable; Redis is pinged here so a suite pointed at a
// missing Redis fails at once instead of passing on lazy connections.
export default async function setup(): Promise<void> {
  const config = loadConfig(process.env);
  await runMigrations(config.databaseUrl);

  const redis = new Redis(config.redisUrl, { lazyConnect: true, retryStrategy: () => null });
  redis.on('error', () => {}); // surfaced by the rejected connect() below
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`Redis is not reachable at ${config.redisUrl}; run \`pnpm deps:up\``, { cause: err });
  } finally {
    redis.disconnect();
  }
}
