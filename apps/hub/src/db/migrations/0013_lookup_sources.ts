import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * The IHS-number cache (#47). The attempt log records, next to how each
 * person was found, where the IHS number came from: `cache` or `remote`.
 * Attempts logged before this migration, and those with no lookup, have `{}`.
 */
export const lookupSourcesMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable('attempt')
      .addColumn('lookup_sources', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
      .execute();
  },
};
