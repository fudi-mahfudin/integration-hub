import { createHub } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';

/** A hub booted for a test, already listening. */
export interface BootedHub {
  /** Where the hub listens, e.g. `http://127.0.0.1:41234/`. */
  baseUrl: URL;
  /** Shuts the hub down and releases its connections. */
  close(): Promise<void>;
}

/**
 * Boots the hub service in-process through the production composition root,
 * on a random port, against the real Postgres and Redis named by the
 * environment (compose locally, service containers in CI).
 */
export async function bootHub(): Promise<BootedHub> {
  const hub = await createHub(loadConfig({ ...process.env, PORT: '0', HOST: '127.0.0.1' }));
  const baseUrl = await hub.listen();
  return { baseUrl, close: () => hub.close() };
}
