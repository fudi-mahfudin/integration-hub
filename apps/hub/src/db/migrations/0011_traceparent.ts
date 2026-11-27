import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Traces (#42). A source event keeps the W3C `traceparent` of the ingest
 * span that accepted it, so its step's attempts join that trace. Null when
 * the event was not traced, and for events accepted before this migration.
 */
export const traceparentMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('source_event').addColumn('traceparent', 'text').execute();
  },
};
