import { createHub } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';

export interface BootedHub {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Boots the hub service in-process through the production composition root,
 * on a random port, against the real Postgres and Redis named by the
 * environment (compose locally, service containers in CI).
 */
export async function bootHub(overrides: Record<string, string> = {}): Promise<BootedHub> {
  const config = loadConfig({ ...process.env, PORT: '0', HOST: '127.0.0.1', ...overrides });
  const hub = await createHub(config);
  const address = await hub.listen();
  return { baseUrl: address, close: () => hub.close() };
}
