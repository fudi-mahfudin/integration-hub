import { Migrator, type MigrationResult } from 'kysely/migration';
import { createDatabase } from './database.js';
import { migrations } from './migrations/index.js';

/**
 * Applies all pending migrations. Only the one-shot `migrate` command (and the
 * test suite's global setup) calls this; the hub and worker never migrate
 * themselves.
 */
export async function runMigrations(databaseUrl: string): Promise<MigrationResult[]> {
  const db = createDatabase(databaseUrl);
  try {
    const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
    const { error, results = [] } = await migrator.migrateToLatest();
    if (error) throw error;
    return results;
  } finally {
    await db.destroy();
  }
}
