import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Reconciliation (#39). A run is a row a worker executes under one advisory
 * lock; at most one run is queued or running at a time, which a partial
 * unique index enforces, so two concurrent requests can't both start one.
 * A run checks each case in its scope once (`reconciliation_checks`: which
 * cases it covered, and how each check ended) and stores what it found as
 * snapshots (`reconciliation_findings`). Deleting a run deletes both.
 */
export const reconciliationMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('reconciliation_runs')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('status', 'text', (c) =>
        c.notNull().check(sql`status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed')`),
      )
      .addColumn('trigger', 'text', (c) => c.notNull().check(sql`trigger in ('operator', 'schedule')`))
      // The on-demand narrowing: only these cases, only cases changed since then; null when not given.
      .addColumn('case_ids', sql`uuid[]`)
      .addColumn('since', 'timestamptz')
      .addColumn('requested_at', 'timestamptz', (c) => c.notNull())
      .addColumn('started_at', 'timestamptz')
      .addColumn('ended_at', 'timestamptz')
      // Why a `failed` run failed; null otherwise.
      .addColumn('error', 'text')
      .execute();
    await db.schema
      .createIndex('reconciliation_runs_one_open_key')
      .unique()
      .on('reconciliation_runs')
      .expression(sql`(true)`)
      .where(sql.ref('status'), 'in', sql`('queued', 'running')`)
      .execute();
    await db.schema.createIndex('reconciliation_runs_requested_idx').on('reconciliation_runs').column('requested_at').execute();

    await db.schema
      .createTable('reconciliation_checks')
      .addColumn('run_id', 'uuid', (c) => c.notNull().references('reconciliation_runs.id').onDelete('cascade'))
      .addColumn('case_id', 'uuid', (c) => c.notNull().references('case.id'))
      .addColumn('outcome', 'text', (c) => c.notNull().check(sql`outcome in ('clean', 'divergent', 'skipped', 'unchecked')`))
      .addColumn('checked_at', 'timestamptz', (c) => c.notNull())
      .addPrimaryKeyConstraint('reconciliation_checks_pkey', ['run_id', 'case_id'])
      .execute();
    await db.schema.createIndex('reconciliation_checks_case_idx').on('reconciliation_checks').column('case_id').execute();

    await db.schema
      .createTable('reconciliation_findings')
      .addColumn('id', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity())
      .addColumn('run_id', 'uuid', (c) => c.notNull())
      .addColumn('case_id', 'uuid', (c) => c.notNull())
      .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('divergence', 'skipped', 'unchecked')`))
      // For a divergence: its class, the step whose expectation it breaks, the resource and the field; null otherwise.
      .addColumn('class', 'text')
      .addColumn('step', 'text')
      .addColumn('resource_type', 'text')
      .addColumn('field', 'text')
      // What was expected and found, never a person's IHS number (only `differs`).
      .addColumn('snapshot', 'jsonb', (c) => c.notNull())
      .addForeignKeyConstraint('reconciliation_findings_check_fkey', ['run_id', 'case_id'], 'reconciliation_checks', ['run_id', 'case_id'], (fk) =>
        fk.onDelete('cascade'),
      )
      .execute();
    await db.schema.createIndex('reconciliation_findings_run_idx').on('reconciliation_findings').columns(['run_id', 'id']).execute();
    await db.schema.createIndex('reconciliation_findings_case_idx').on('reconciliation_findings').columns(['case_id', 'run_id']).execute();
  },
};
