import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Update visit (#31). A recorded `visit.started` or `visit.finished` keeps
 * its `startedAt` or `finishedAt` beside its envelope, so whichever arrives
 * second can be checked against the other (`finishedAt > startedAt`, #9).
 * Visits started before this migration get theirs from the stored envelope,
 * truncated to the millisecond as ingest parses it.
 */
export const updateVisitMigration: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('source_event').addColumn('visit_time', 'timestamptz').execute();
    await sql`
      update source_event
         set visit_time = date_trunc('milliseconds', (envelope->'data'->>'startedAt')::timestamptz)
       where type = 'visit.started'
    `.execute(db);
  },
};
