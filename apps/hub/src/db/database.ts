import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';
import type { CaseStatus, EventType, StepName, StepState } from '../cases/case-model.js';

/** A `timestamptz` column: read as a `Date`, written as a `Date`. */
type Timestamp = ColumnType<Date, Date, Date>;

/** A case: the hub's record of one visit of one source system. */
export interface CaseTable {
  id: Generated<string>;
  source_system_id: string;
  organization_id: string;
  visit_id: string;
  status: CaseStatus;
  opened_at: Timestamp;
  updated_at: Timestamp;
}

/** One of a case's four ordered steps. */
export interface StepTable {
  case_id: string;
  seq: number;
  name: StepName;
  event_type: EventType;
  state: StepState;
  updated_at: Timestamp;
}

/** An accepted source event, stored as received (after schema validation). */
export interface SourceEventTable {
  id: Generated<string>;
  case_id: string;
  type: EventType;
  occurred_at: Timestamp;
  envelope: ColumnType<unknown, string, never>;
  received_at: Timestamp;
}

/** An accepted idempotency key, its body fingerprint, and the answer it was given. */
export interface IdempotencyKeyTable {
  source_system_id: string;
  key: string;
  fingerprint: string;
  response: ColumnType<unknown, string | null, string>;
  created_at: Timestamp;
}

/** Every table, as Kysely sees it. */
export interface Database {
  case: CaseTable;
  step: StepTable;
  source_event: SourceEventTable;
  idempotency_key: IdempotencyKeyTable;
}

/**
 * Builds a Kysely instance over a Postgres pool. The pool connects lazily;
 * callers own it and must `destroy()` it. Only the composition root calls this.
 */
export function createDatabase(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}
