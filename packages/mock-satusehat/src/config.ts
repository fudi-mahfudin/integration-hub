import { DEFAULT_WORLD_PATH } from './world/world.js';

/**
 * The mock's static settings, read from the environment once. Fault rules,
 * holds and extra seed data are never configured here: only through `/__mock/*`.
 */
export interface MockConfig {
  /** Interface the HTTP server binds to. */
  host: string;
  /** TCP port; `0` picks a free port. */
  port: number;
  /** The world dataset file loaded at boot and on every reset. */
  worldPath: URL | string;
  /** `expires_in` of issued access tokens, in seconds. */
  tokenExpiresInSeconds: number;
  /** After a failed token request, further token requests within this many seconds get 429. */
  tokenThrottleWindowSeconds: number;
}

type Env = Record<string, string | undefined>;

/** Reads and validates the mock's configuration. A clean clone needs no .env. Throws naming the bad variable. */
export function loadConfig(env: Env): MockConfig {
  return {
    host: parseHost(env.HOST ?? '0.0.0.0'),
    port: parseInteger('PORT', env.PORT ?? '3001', 0, 65535),
    worldPath: env.MOCK_WORLD_PATH ?? DEFAULT_WORLD_PATH,
    tokenExpiresInSeconds: parseInteger('MOCK_TOKEN_EXPIRES_IN_SECONDS', env.MOCK_TOKEN_EXPIRES_IN_SECONDS ?? '3599', 1, 86_400),
    tokenThrottleWindowSeconds: parseInteger(
      'MOCK_TOKEN_THROTTLE_WINDOW_SECONDS',
      env.MOCK_TOKEN_THROTTLE_WINDOW_SECONDS ?? '60',
      0,
      86_400,
    ),
  };
}

function parseHost(raw: string): string {
  if (raw.trim() === '') throw new Error('HOST must be a hostname or IP address, got an empty string');
  return raw;
}

function parseInteger(name: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer ${min}-${max}, got "${raw}"`);
  }
  return n;
}
