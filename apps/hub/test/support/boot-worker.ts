import { systemClock } from '../../src/clock.js';
import { createWorker } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';
import type { LogDestination } from '../../src/observability/log.js';

/** A worker booted for a test, already claiming steps. */
export interface BootedWorker {
  /** Stops claiming, waits for the attempt in progress, and releases its connections. */
  close(): Promise<void>;
}

/**
 * Boots a worker in-process through the production composition root and
 * starts it. `env` overrides the process environment; point `DATABASE_URL`
 * at a `createFreshDatabase()` URL, since a worker claims every ready step it
 * can see. Log lines go to `logs`, stdout by default.
 */
export async function bootWorker(env: Record<string, string>, logs: LogDestination = process.stdout): Promise<BootedWorker> {
  const worker = await createWorker(loadConfig({ ...process.env, ...env }), { clock: systemClock, logs });
  worker.start();
  return { close: () => worker.close() };
}
