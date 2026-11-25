import type { Kysely } from 'kysely';
import { Migrator, type MigrationResult } from 'kysely/migration';
import type { Database } from './database.js';
import { migrations } from './migrations/index.js';

/**
 * Applies all pending migrations to `db` and returns what ran (empty when the
 * schema is already up to date). Only the one-shot `migrate` command and the
 * test suite's global setup reach this; the hub and worker never migrate
 * themselves.
 */
export async function runMigrations(db: Kysely<Database>): Promise<MigrationResult[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results = [] } = await migrator.migrateToLatest();
  if (error) throw error;
  return results;
}
