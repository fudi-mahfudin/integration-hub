import { systemClock, type Clock } from '../../src/clock.js';
import { createHub } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';

/** A hub booted for a test, already listening. */
export interface BootedHub {
  /** Where the hub listens, e.g. `http://127.0.0.1:41234/`. */
  baseUrl: URL;
  /** Runs the idempotency-key purge job now; resolves to how many keys it deleted. */
  purgeIdempotencyKeys(): Promise<number>;
  /** Shuts the hub down and releases its connections. */
  close(): Promise<void>;
}

/**
 * Boots the hub service in-process through the production composition root,
 * on a random port, against the real Postgres and Redis named by the
 * environment (compose locally, service containers in CI). `env` overrides
 * the process environment. The purge timer is off; tests trigger the purge
 * with `purgeIdempotencyKeys`.
 */
export async function bootHub(env: Record<string, string> = {}, clock: Clock = systemClock): Promise<BootedHub> {
  const config = loadConfig({
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    IDEMPOTENCY_PURGE_INTERVAL_MS: '0',
    ...env,
  });
  const hub = await createHub(config, { clock });
  const baseUrl = await hub.listen();
  return { baseUrl, purgeIdempotencyKeys: () => hub.purgeIdempotencyKeys(), close: () => hub.close() };
}
