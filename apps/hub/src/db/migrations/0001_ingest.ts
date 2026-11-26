import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Ingest (#25): cases keyed by (source system, visit), their four step rows,
 * the source events, and the idempotency keys in a table of their own so a
 * periodic job can purge them (#7, ADR 0003).
 */
export const ingestMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('case')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
      .addColumn('source_system_id', 'text', (c) => c.notNull())
      .addColumn('organization_id', 'text', (c) => c.notNull())
      .addColumn('visit_id', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) =>
        c.notNull().check(sql`status in ('waiting', 'active', 'dead_lettered', 'completed', 'abandoned')`),
      )
      .addColumn('opened_at', 'timestamptz', (c) => c.notNull())
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
      // A case is keyed by (source system, visitId) (#6).
      .addUniqueConstraint('case_source_system_visit_key', ['source_system_id', 'visit_id'])
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
      // One event per type per case: a second one is EVENT_ALREADY_RECORDED (#6).
      .addUniqueConstraint('source_event_case_type_key', ['case_id', 'type'])
      .execute();

    await db.schema
      .createTable('idempotency_key')
      .addColumn('source_system_id', 'text', (c) => c.notNull())
      .addColumn('key', 'text', (c) => c.notNull())
      .addColumn('fingerprint', 'text', (c) => c.notNull())
      // Null only inside the accepting transaction, which sets it before commit.
      .addColumn('response', 'jsonb')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull())
      // ADR 0003: this constraint is what detects a duplicate ingest.
      .addPrimaryKeyConstraint('idempotency_key_pkey', ['source_system_id', 'key'])
      .execute();
    await db.schema.createIndex('idempotency_key_created_at_idx').on('idempotency_key').column('created_at').execute();
  },
};
