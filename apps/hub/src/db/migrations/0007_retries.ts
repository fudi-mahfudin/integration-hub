import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Retries (#35). A step in `retry_wait` is claimable again from its
 * `available_at`; the claim index covers it. An attempt keeps its read
 * retries as sub-entries, and may end `attempt_budget_exceeded` (#13).
 */
export const retriesMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('step').addColumn('available_at', 'timestamptz').execute();
    await db.schema.dropIndex('step_claimable_idx').execute();
    await db.schema
      .createIndex('step_claimable_idx')
      .on('step')
      .column('updated_at')
      .where(sql.ref('state'), 'in', sql`('ready', 'in_flight', 'retry_wait')`)
      .execute();

    await db.schema.alterTable('attempt').addColumn('read_retries', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`)).execute();
    await db.schema.alterTable('attempt').dropConstraint('attempt_outcome_check').execute();
    await db.schema
      .alterTable('attempt')
      .addCheckConstraint(
        'attempt_outcome_check',
        sql`outcome in ('completed', 'dead_lettered', 'discarded', 'failed', 'lease_expired', 'attempt_budget_exceeded')`,
      )
      .execute();
  },
};
