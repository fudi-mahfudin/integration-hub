import { migrateDatabase } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';

/**
 * Vitest global setup. The hub never migrates itself, so the suite runs the
 * same step the one-shot `migrate` command runs, once, before any hub boots.
 * Redis reachability is proven by the hub itself, which fails to boot without it.
 */
export default async function setup(): Promise<void> {
  await migrateDatabase(loadConfig(process.env));
}
