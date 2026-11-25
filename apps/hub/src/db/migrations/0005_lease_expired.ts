import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Lease expiry as an attempt outcome (#8, #34): when a worker reclaims a step
 * whose lease expired, the lost attempt gets its `lease_expired` row.
 */
export const migration0005: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table step_attempt drop constraint step_attempt_outcome_check`.execute(db);
    await sql`alter table step_attempt add constraint step_attempt_outcome_check
      check (outcome in ('completed', 'dead_lettered', 'retry_wait', 'lease_expired'))`.execute(db);
  },

  async down(db: Kysely<unknown>) {
    await sql`delete from step_attempt where outcome = 'lease_expired'`.execute(db);
    await sql`alter table step_attempt drop constraint step_attempt_outcome_check`.execute(db);
    await sql`alter table step_attempt add constraint step_attempt_outcome_check
      check (outcome in ('completed', 'dead_lettered', 'retry_wait'))`.execute(db);
  },
};
