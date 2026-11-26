import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Submit prescription (#29). A recorded `prescription.written` keeps its
 * prescription and item identifiers beside its envelope, so a second
 * prescription for the visit can be told apart from a resend of the same one.
 * Ingest rejections are logged by (source system, visitId), without bodies
 * (#8). Local drug codes map to KFA codes by operator mapping, and KFA
 * details are stored once fetched, shared by every source (#10).
 */
export const submitPrescriptionMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('source_event').addColumn('prescription_id', 'text').addColumn('item_id', 'text').execute();

    await db.schema
      .createTable('rejection')
      .addColumn('id', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity())
      .addColumn('source_system_id', 'text', (c) => c.notNull())
      .addColumn('visit_id', 'text', (c) => c.notNull())
      .addColumn('event_type', 'text', (c) => c.notNull())
      .addColumn('code', 'text', (c) => c.notNull())
      .addColumn('rejected_at', 'timestamptz', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('rejection_visit_idx').on('rejection').columns(['source_system_id', 'visit_id', 'id']).execute();

    await db.schema
      .createTable('drug_mapping')
      .addColumn('source_system_id', 'text', (c) => c.notNull())
      .addColumn('drug_code', 'text', (c) => c.notNull())
      .addColumn('kfa_code', 'text', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addPrimaryKeyConstraint('drug_mapping_pkey', ['source_system_id', 'drug_code'])
      .execute();

    await db.schema
      .createTable('kfa_product')
      .addColumn('code', 'text', (c) => c.primaryKey())
      .addColumn('display', 'text', (c) => c.notNull())
      .addColumn('level', 'smallint', (c) => c.notNull())
      .addColumn('parent_92', 'text')
      .addColumn('active_ingredients', 'jsonb', (c) => c.notNull())
      .addColumn('dose_form_code', 'text')
      .addColumn('dose_form_display', 'text')
      .addColumn('fetched_at', 'timestamptz', (c) => c.notNull())
      .addCheckConstraint('kfa_product_dose_form_both_or_neither', sql`(dose_form_code is null) = (dose_form_display is null)`)
      .execute();
  },
};
