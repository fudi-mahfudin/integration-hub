import type { MockOptions } from './server.js';

/**
 * Static settings only (#12). Fault rules, holds and extra seed data are set
 * through the `/__mock/*` API, never through env.
 */
export function loadMockConfig(env: Record<string, string | undefined>): Required<Omit<MockOptions, 'worldPath'>> & { worldPath: string | undefined } {
  return {
    host: env.MOCK_HOST ?? '0.0.0.0',
    port: int(env, 'MOCK_PORT', 4010),
    worldPath: env.MOCK_WORLD_PATH,
    tokenExpiresInSeconds: int(env, 'MOCK_TOKEN_EXPIRES_IN', 3599),
    tokenThrottleWindowMs: int(env, 'MOCK_TOKEN_THROTTLE_WINDOW_MS', 60_000),
  };
}

function int(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}
