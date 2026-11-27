import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Replay and abandonment (#37, ADR 0007). A step gains the final `abandoned`
 * state, and keeps what replay resets: how many of its attempts came before
 * its last replay (the cap counts only the ones after), and when that replay
 * was (KFA details fetched before it are fetched again). A case keeps since
 * when it is dead-lettered. Each replay is a row of its own; an abandonment
 * records its note and what the case was left as.
 */
export const replayAndAbandonMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('step').dropConstraint('step_state_check').execute();
    await db.schema
      .alterTable('step')
      .addCheckConstraint(
        'step_state_check',
        sql`state in ('awaiting_event', 'blocked', 'ready', 'in_flight', 'retry_wait', 'completed', 'dead_lettered', 'abandoned')`,
      )
      .execute();
    await db.schema
      .alterTable('step')
      .addColumn('attempts_before_replay', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('replayed_at', 'timestamptz')
      .execute();

    await db.schema.alterTable('case').addColumn('dead_lettered_since', 'timestamptz').execute();
    // A dead-lettered case changes no more until an operator acts: its last update is when it was dead-lettered.
    await sql`update "case" set dead_lettered_since = updated_at where status = 'dead_lettered'`.execute(db);

    await db.schema
      .createTable('replay')
      .addColumn('id', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity())
      .addColumn('case_id', 'uuid', (c) => c.notNull().references('case.id').onDelete('cascade'))
      .addColumn('seq', 'smallint', (c) => c.notNull())
      // The dead-letter reason the replay cleared.
      .addColumn('reason', 'text', (c) => c.notNull())
      .addColumn('note', 'text')
      .addColumn('replayed_at', 'timestamptz', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('replay_case_idx').on('replay').columns(['case_id', 'id']).execute();

    await db.schema
      .createTable('abandonment')
      .addColumn('case_id', 'uuid', (c) => c.primaryKey().references('case.id').onDelete('cascade'))
      .addColumn('note', 'text', (c) => c.notNull().check(sql`btrim(note) <> ''`))
      .addColumn('abandoned_at', 'timestamptz', (c) => c.notNull())
      .addColumn('previous_status', 'text', (c) => c.notNull().check(sql`previous_status in ('waiting', 'dead_lettered')`))
      .addColumn('waiting_for', 'text')
      .addColumn('dead_letter_reason', 'text')
      // The records completed steps left at SATUSEHAT, as JSON `[{ step, type, id, version }]`.
      .addColumn('remote_records_left', 'jsonb', (c) => c.notNull())
      .execute();
  },
};
