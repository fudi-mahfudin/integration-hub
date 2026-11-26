import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Step-time validation, pins and the attempt log (#28). Each step has an
 * append-only attempt log, one row per attempt, that the database refuses to
 * update or delete; a completed step pins the values it sent (#10).
 */
export const attemptLogAndPinsMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('step').addColumn('pins', 'jsonb').execute();

    await db.schema
      .createTable('attempt')
      .addColumn('case_id', 'uuid', (c) => c.notNull())
      .addColumn('seq', 'smallint', (c) => c.notNull())
      .addColumn('attempt', 'integer', (c) => c.notNull())
      .addColumn('started_at', 'timestamptz', (c) => c.notNull())
      .addColumn('ended_at', 'timestamptz', (c) => c.notNull())
      .addColumn('outcome', 'text', (c) =>
        c.notNull().check(sql`outcome in ('completed', 'dead_lettered', 'discarded', 'failed')`),
      )
      .addColumn('error_code', 'text')
      .addColumn('http_status', 'smallint')
      .addColumn('values_used', 'jsonb', (c) => c.notNull())
      .addColumn('lookup_methods', 'jsonb', (c) => c.notNull())
      .addColumn('violations', 'jsonb', (c) => c.notNull())
      .addPrimaryKeyConstraint('attempt_pkey', ['case_id', 'seq', 'attempt'])
      .addForeignKeyConstraint('attempt_step_fkey', ['case_id', 'seq'], 'step', ['case_id', 'seq'])
      .execute();

    await sql`
      create function attempt_is_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'the attempt log is append-only: % on attempt is not allowed', tg_op;
      end
      $$
    `.execute(db);
    await sql`
      create trigger attempt_append_only before update or delete on attempt
      for each row execute function attempt_is_append_only()
    `.execute(db);
  },
};
