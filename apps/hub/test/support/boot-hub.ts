import { createHub, type HubOptions } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';

export interface BootedHub {
  baseUrl: string;
  /** Triggers the idempotency-key purge job now. */
  purgeIdempotencyKeys(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Boots the hub service in-process through the production composition root,
 * on a random port, against the real Postgres and Redis named by the
 * environment (compose locally, service containers in CI). The purge timer is
 * off unless an override turns it on; trigger it with `purgeIdempotencyKeys`.
 */
export async function bootHub(overrides: Record<string, string> = {}, options: HubOptions = {}): Promise<BootedHub> {
  const config = loadConfig({
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    IDEMPOTENCY_PURGE_INTERVAL_MS: '0',
    ...overrides,
  });
  const hub = await createHub(config, options);
  const address = await hub.listen();
  return { baseUrl: address, purgeIdempotencyKeys: () => hub.purgeIdempotencyKeys(), close: () => hub.close() };
}
