import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * The case list and the event history (#38). A case gains `list_seq`, given
 * once at insert and never changed: the case list orders by it, so its
 * cursor names a fixed place however the cases change. A source event counts
 * the duplicate ingests answered with its original `202`.
 */
export const caseListMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('case').addColumn('list_seq', 'bigint', (c) => c.generatedAlwaysAsIdentity()).execute();
    await db.schema.createIndex('case_list_seq_key').unique().on('case').column('list_seq').execute();
    await db.schema.alterTable('source_event').addColumn('duplicates', 'integer', (c) => c.notNull().defaultTo(0)).execute();
  },
};
