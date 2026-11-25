export interface HubConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
}

type Env = Record<string, string | undefined>;

/** Defaults match compose.yaml, so a clean clone needs no .env. */
export function loadConfig(env: Env): HubConfig {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: parsePort(env.PORT ?? '3000'),
    databaseUrl: env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer 0-65535, got "${raw}"`);
  }
  return port;
}
