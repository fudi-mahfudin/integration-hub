import { systemClock } from '../../src/clock.js';
import { createWorker } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';
import type { LogDestination } from '../../src/observability/log.js';

/** A worker booted for a test, already claiming steps. */
export interface BootedWorker {
  /** Where the worker serves `/metrics`, e.g. `http://127.0.0.1:41235/`. */
  baseUrl: URL;
  /** Drains the worker (see `HubWorker.close`) and releases its connections. */
  close(): Promise<void>;
}

/**
 * Boots a worker in-process through the production composition root and
 * starts it. `env` overrides the process environment; point `DATABASE_URL`
 * at a `createFreshDatabase()` URL, since a worker claims every ready step it
 * can see. Its metrics server listens on a random port. Log lines go to
 * `logs`, stdout by default.
 */
export async function bootWorker(env: Record<string, string>, logs: LogDestination = process.stdout): Promise<BootedWorker> {
  const worker = await createWorker(loadConfig({ ...process.env, WORKER_PORT: '0', HOST: '127.0.0.1', ...env }), { clock: systemClock, logs });
  const baseUrl = await worker.listen();
  await worker.start();
  return { baseUrl, close: () => worker.close() };
}
