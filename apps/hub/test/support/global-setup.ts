import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { migrateDatabase } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config.js';
import { readRedis } from './redis-contents.js';

/**
 * Vitest global setup. The hub never migrates itself, so the suite runs the
 * same step the one-shot `migrate` command runs, once, before any hub boots.
 * Redis reachability is proven by the hub itself, which fails to boot without it.
 *
 * Its teardown, after the whole suite, is the canary check of Redis (#47):
 * no world NIK may be in any key or value any test left there, so the
 * suite fails if one is.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const config = loadConfig(process.env);
  await migrateDatabase(config);
  return async () => {
    const world = await loadWorld(DEFAULT_WORLD_PATH);
    const niks = [...world.patients, ...world.practitioners].flatMap((person) => [person.nik, ...('motherNik' in person ? [person.motherNik] : [])]);
    const { keys, values } = await readRedis(config.redisUrl);
    const leaked = niks.filter((nik) => [...keys, ...values].some((entry) => entry.includes(nik)));
    if (leaked.length > 0) throw new Error(`after the suite, Redis holds ${leaked.length} world NIK(s) in a key or value; it must hold none (#47)`);
  };
}
