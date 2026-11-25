import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Outbox and create visit (#27): the step row is the outbox entry (ADR 0002),
 * so it gains its lease, attempt counter, retry time, remote identifier and
 * dead-letter reason. Location mappings are operator data keyed by
 * (source, local code) (#10).
 */
export const migration0002: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable('step')
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      // A fresh token per claim; completion must present it (lease fence, #8).
      .addColumn('lease_token', 'uuid')
      .addColumn('lease_expires_at', 'timestamptz')
      // When a `retry_wait` step becomes claimable again.
      .addColumn('available_at', 'timestamptz')
      .addColumn('remote_type', 'text')
      .addColumn('remote_id', 'text')
      .addColumn('remote_version', 'text')
      .addColumn('dead_letter_reason', 'text')
      .execute();
    // The claim query scans only claimable rows.
    await db.schema
      .createIndex('step_claimable_idx')
      .on('step')
      .columns(['state', 'updated_at'])
      .where(sql.ref('state'), 'in', sql`('ready', 'retry_wait', 'in_flight')`)
      .execute();

    await db.schema
      .createTable('location_mapping')
      .addColumn('source_id', 'text', (c) => c.notNull())
      .addColumn('location_code', 'text', (c) => c.notNull())
      .addColumn('location_id', 'text', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addPrimaryKeyConstraint('location_mapping_pkey', ['source_id', 'location_code'])
      .execute();
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('location_mapping').execute();
    await db.schema.dropIndex('step_claimable_idx').execute();
    await db.schema
      .alterTable('step')
      .dropColumn('attempts')
      .dropColumn('lease_token')
      .dropColumn('lease_expires_at')
      .dropColumn('available_at')
      .dropColumn('remote_type')
      .dropColumn('remote_id')
      .dropColumn('remote_version')
      .dropColumn('dead_letter_reason')
      .execute();
  },
};
