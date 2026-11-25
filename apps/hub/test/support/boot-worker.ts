import { createWorker, type HubOptions } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';

export interface BootedWorker {
  /** Stops claiming, waits for attempts in progress, disconnects. */
  close(): Promise<void>;
}

/**
 * Boots a worker in-process through the production composition root, against
 * the environment plus `overrides`, and starts it. Point it at a
 * `createFreshDatabase()` URL: a worker claims every ready step it can see.
 */
export async function bootWorker(overrides: Record<string, string> = {}, options: HubOptions = {}): Promise<BootedWorker> {
  const worker = await createWorker(loadConfig({ ...process.env, ...overrides }), options);
  worker.start();
  return { close: () => worker.close() };
}
