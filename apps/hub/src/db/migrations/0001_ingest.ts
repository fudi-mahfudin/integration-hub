import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Ingest (#25): cases keyed by (source, visit), their four steps, the
 * immutable source events, and the idempotency keys in their own table so a
 * periodic job can purge them (#7, ADR 0003).
 */
export const migration0001: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('case')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('source_id', 'text', (c) => c.notNull())
      .addColumn('organization_id', 'text', (c) => c.notNull())
      .addColumn('visit_id', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) =>
        c.notNull().check(sql`status in ('waiting', 'active', 'dead_lettered', 'completed', 'abandoned')`),
      )
      .addColumn('waiting_for', 'text')
      .addColumn('waiting_since', 'timestamptz')
      .addColumn('opened_at', 'timestamptz', (c) => c.notNull())
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addUniqueConstraint('case_source_visit_key', ['source_id', 'visit_id'])
      .execute();

    await db.schema
      .createTable('step')
      .addColumn('case_id', 'uuid', (c) => c.notNull().references('case.id').onDelete('cascade'))
      .addColumn('seq', 'smallint', (c) => c.notNull().check(sql`seq between 1 and 4`))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('event_type', 'text', (c) => c.notNull())
      .addColumn('state', 'text', (c) =>
        c
          .notNull()
          .check(
            sql`state in ('awaiting_event', 'blocked', 'ready', 'in_flight', 'retry_wait', 'completed', 'dead_lettered')`,
          ),
      )
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      .addPrimaryKeyConstraint('step_pkey', ['case_id', 'seq'])
      .execute();

    await db.schema
      .createTable('source_event')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('case_id', 'uuid', (c) => c.notNull().references('case.id').onDelete('cascade'))
      .addColumn('type', 'text', (c) => c.notNull())
      .addColumn('occurred_at', 'timestamptz', (c) => c.notNull())
      .addColumn('envelope', 'jsonb', (c) => c.notNull())
      .addColumn('received_at', 'timestamptz', (c) => c.notNull())
      // One event per type per case: the second is EVENT_ALREADY_RECORDED (#6).
      .addUniqueConstraint('source_event_case_type_key', ['case_id', 'type'])
      .execute();

    await db.schema
      .createTable('idempotency_key')
      .addColumn('source_id', 'text', (c) => c.notNull())
      .addColumn('key', 'text', (c) => c.notNull())
      .addColumn('fingerprint', 'text', (c) => c.notNull())
      .addColumn('response_status', 'smallint')
      .addColumn('response_headers', 'jsonb')
      .addColumn('response_body', 'text')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull())
      // ADR 0003: the uniqueness constraint is the duplicate detector.
      .addPrimaryKeyConstraint('idempotency_key_pkey', ['source_id', 'key'])
      .execute();
    await db.schema.createIndex('idempotency_key_created_at_idx').on('idempotency_key').column('created_at').execute();
  },

  async down(db: Kysely<unknown>) {
    for (const table of ['idempotency_key', 'source_event', 'step', 'case']) {
      await db.schema.dropTable(table).execute();
    }
  },
};
