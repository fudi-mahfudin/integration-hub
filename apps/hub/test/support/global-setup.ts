import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';

// The hub never migrates itself, so the suite runs the same step the
// one-shot `migrate` command runs, once, before any hub boots.
export default async function setup(): Promise<void> {
  await runMigrations(loadConfig(process.env).databaseUrl);
}
