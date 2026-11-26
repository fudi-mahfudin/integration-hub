import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Create visit (#27). The step row is its own outbox entry (ADR 0002), so it
 * gains its lease, attempt counter, remote identifier and dead-letter reason;
 * a waiting case names the event it waits for and since when; location
 * mappings are operator data keyed by (source system, local code) (#10).
 */
export const createVisitMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable('case')
      .addColumn('waiting_for', 'text')
      .addColumn('waiting_since', 'timestamptz')
      .execute();

    await db.schema
      .alterTable('step')
      // Incremented on every claim (#8).
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      // A fresh token per claim; an outcome is applied only while it still matches (lease fence, #8).
      .addColumn('lease_token', 'uuid')
      .addColumn('lease_expires_at', 'timestamptz')
      .addColumn('remote_type', 'text')
      .addColumn('remote_id', 'text')
      .addColumn('remote_version', 'text')
      .addColumn('dead_letter_reason', 'text')
      .execute();
    // The claim query scans only claimable rows.
    await db.schema
      .createIndex('step_claimable_idx')
      .on('step')
      .column('updated_at')
      .where(sql.ref('state'), 'in', sql`('ready', 'in_flight')`)
      .execute();

    await db.schema
      .createTable('location_mapping')
      .addColumn('source_system_id', 'text', (c) => c.notNull())
      .addColumn('location_code', 'text', (c) => c.notNull())
      .addColumn('location_id', 'text', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addPrimaryKeyConstraint('location_mapping_pkey', ['source_system_id', 'location_code'])
      .execute();
  },
};
