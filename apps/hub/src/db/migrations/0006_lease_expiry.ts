import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Lease expiry (#34). A step keeps when its current claim was taken, so the
 * claim that takes over an expired lease can log the expired attempt with
 * its start; the attempt log gains the `lease_expired` outcome (#8). Steps in
 * flight before this migration were last updated by their claim.
 */
export const leaseExpiryMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('step').addColumn('claimed_at', 'timestamptz').execute();
    await sql`update step set claimed_at = updated_at where state = 'in_flight'`.execute(db);

    await db.schema.alterTable('attempt').dropConstraint('attempt_outcome_check').execute();
    await db.schema
      .alterTable('attempt')
      .addCheckConstraint('attempt_outcome_check', sql`outcome in ('completed', 'dead_lettered', 'discarded', 'failed', 'lease_expired')`)
      .execute();
  },
};
