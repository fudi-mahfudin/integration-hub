import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Attempt log and pins (#28). Every finished attempt appends one
 * `step_attempt` row (never updated or deleted); a completed step stores the
 * values it sent as `pins`, written in the same transaction as its remote
 * identifier (#10).
 */
export const migration0003: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable('step')
      // When the current claim started: the attempt's start time.
      .addColumn('claimed_at', 'timestamptz')
      .addColumn('pins', 'jsonb')
      .execute();

    await db.schema
      .createTable('step_attempt')
      .addColumn('case_id', 'uuid', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('attempt', 'integer', (c) => c.notNull())
      .addColumn('started_at', 'timestamptz', (c) => c.notNull())
      .addColumn('ended_at', 'timestamptz', (c) => c.notNull())
      .addColumn('outcome', 'text', (c) => c.notNull().check(sql`outcome in ('completed', 'dead_lettered', 'retry_wait')`))
      .addColumn('error_code', 'text')
      .addColumn('http_status', 'integer')
      // Values the attempt resolved and used, with the lookup method (#10).
      .addColumn('used', 'jsonb', (c) => c.notNull())
      // Every Validation violation, in rule order (#9).
      .addColumn('violations', 'jsonb', (c) => c.notNull())
      .addColumn('detail', 'text')
      .addPrimaryKeyConstraint('step_attempt_pkey', ['case_id', 'seq', 'attempt'])
      .addForeignKeyConstraint('step_attempt_step_fkey', ['case_id', 'seq'], 'step', ['case_id', 'seq'], (c) => c.onDelete('cascade'))
      .execute();
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('step_attempt').execute();
    await db.schema.alterTable('step').dropColumn('claimed_at').dropColumn('pins').execute();
  },
};
