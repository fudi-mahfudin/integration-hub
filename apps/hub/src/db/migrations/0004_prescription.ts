import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Submit prescription (#29): the ingest rejection log (#8), drug mappings
 * (operator-kept, #10) and the stored KFA product details (fetched from KFA
 * v2 on first use, shared by all sources, #10).
 */
export const migration0004: Migration = {
  async up(db: Kysely<unknown>) {
    // Keyed by (source, visitId), not by case: a rejection may come before the case opens. No body (#8).
    await db.schema
      .createTable('ingest_rejection')
      .addColumn('id', 'bigserial', (c) => c.primaryKey())
      .addColumn('source_id', 'text', (c) => c.notNull())
      .addColumn('visit_id', 'text', (c) => c.notNull())
      .addColumn('code', 'text', (c) => c.notNull())
      .addColumn('event_type', 'text')
      .addColumn('rejected_at', 'timestamptz', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ingest_rejection_visit_idx').on('ingest_rejection').columns(['source_id', 'visit_id', 'id']).execute();

    await db.schema
      .createTable('drug_mapping')
      .addColumn('source_id', 'text', (c) => c.notNull())
      .addColumn('drug_code', 'text', (c) => c.notNull())
      .addColumn('kfa_code', 'text', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addPrimaryKeyConstraint('drug_mapping_pkey', ['source_id', 'drug_code'])
      .execute();

    await db.schema
      .createTable('kfa_product')
      .addColumn('kfa_code', 'text', (c) => c.primaryKey())
      .addColumn('level', 'integer', (c) => c.notNull())
      .addColumn('display', 'text', (c) => c.notNull())
      .addColumn('parent_92', 'text')
      // The set of active-ingredient (91) codes, sorted.
      .addColumn('ingredients', 'jsonb', (c) => c.notNull())
      .addColumn('dose_form_code', 'text')
      .addColumn('dose_form_name', 'text')
      .addColumn('fetched_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('kfa_product').execute();
    await db.schema.dropTable('drug_mapping').execute();
    await db.schema.dropTable('ingest_rejection').execute();
  },
};
