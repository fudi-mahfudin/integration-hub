import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Graceful shutdown (#43). An attempt a draining worker released at its
 * drain deadline is logged `worker_shutdown`; a reconciliation run a
 * shutting-down worker stopped ends `interrupted`, and is never resumed.
 */
export const gracefulShutdownMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('attempt').dropConstraint('attempt_outcome_check').execute();
    await db.schema
      .alterTable('attempt')
      .addCheckConstraint(
        'attempt_outcome_check',
        sql`outcome in ('completed', 'dead_lettered', 'discarded', 'failed', 'lease_expired', 'attempt_budget_exceeded', 'worker_shutdown')`,
      )
      .execute();
    await db.schema.alterTable('reconciliation_runs').dropConstraint('reconciliation_runs_status_check').execute();
    await db.schema
      .alterTable('reconciliation_runs')
      .addCheckConstraint('reconciliation_runs_status_check', sql`status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed', 'interrupted')`)
      .execute();
  },
};
