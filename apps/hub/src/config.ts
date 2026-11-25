/** Everything the hub reads from its environment, validated once at startup. */
export interface HubConfig {
  /** Interface the HTTP server binds to. */
  host: string;
  /** TCP port the HTTP server listens on; `0` picks a free port. */
  port: number;
  /** Postgres connection URL (`postgres://` or `postgresql://`). */
  databaseUrl: string;
  /** Redis connection URL (`redis://` or `rediss://`). */
  redisUrl: string;
}

type Env = Record<string, string | undefined>;

/**
 * Reads and validates the hub's configuration. Defaults match compose.yaml,
 * so a clean clone needs no .env. Throws on the first invalid variable,
 * naming it.
 */
export function loadConfig(env: Env): HubConfig {
  return {
    host: parseHost(env.HOST ?? '0.0.0.0'),
    port: parsePort(env.PORT ?? '3000'),
    databaseUrl: parseUrl('DATABASE_URL', env.DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub', [
      'postgres:',
      'postgresql:',
    ]),
    redisUrl: parseUrl('REDIS_URL', env.REDIS_URL ?? 'redis://localhost:6379', ['redis:', 'rediss:']),
  };
}

function parseHost(raw: string): string {
  if (raw.trim() === '') {
    throw new Error('HOST must be a hostname or IP address, got an empty string');
  }
  return raw;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer 0-65535, got "${raw}"`);
  }
  return port;
}

function parseUrl(name: string, raw: string, protocols: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The value may hold a password, so it is not echoed back.
    throw new Error(`${name} must be a URL starting with ${protocols.join(' or ')}//, got an unparseable value`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}, got "${url.protocol}"`);
  }
  return raw;
}
