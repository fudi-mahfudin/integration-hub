import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';
import type { CaseStatus, DeadLetterReason, EventType, RemoteIdentifier, StepName, StepState } from '../cases/case-model.js';

/** A `timestamptz` column: read as a `Date`, written as a `Date`. */
type Timestamp = ColumnType<Date, Date, Date>;

/** A case: the hub's record of one visit of one source system. */
export interface CaseTable {
  id: Generated<string>;
  source_system_id: string;
  organization_id: string;
  visit_id: string;
  status: CaseStatus;
  /** The event a `waiting` case waits for; null otherwise. */
  waiting_for: EventType | null;
  /** Since when the case has waited for `waiting_for`; null unless `waiting`. */
  waiting_since: Timestamp | null;
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
  /** How many times the step has been claimed. */
  attempts: Generated<number>;
  /** The current claim's lease token; null unless `in_flight`. */
  lease_token: string | null;
  lease_expires_at: Timestamp | null;
  /** The record the step's completion stored at SATUSEHAT. */
  remote_type: RemoteIdentifier['type'] | null;
  remote_id: string | null;
  remote_version: string | null;
  dead_letter_reason: DeadLetterReason | null;
  /** The values a completed step sent (#10); null until it completes. Read through `cases/pins.ts`. */
  pins: ColumnType<unknown, string | null, string | null>;
  updated_at: Timestamp;
}

/** How an attempt ended. `discarded`: it lost its lease before storing its outcome; `failed`: it ended without an outcome. */
export type AttemptOutcome = 'completed' | 'dead_lettered' | 'discarded' | 'failed';

/** One row of a step's append-only attempt log (#8); the database rejects updates and deletes. */
export interface AttemptTable {
  case_id: string;
  seq: number;
  attempt: number;
  started_at: Timestamp;
  ended_at: Timestamp;
  outcome: AttemptOutcome;
  /** The dead-letter reason the attempt reached; null otherwise. */
  error_code: DeadLetterReason | null;
  http_status: number | null;
  values_used: ColumnType<unknown, string, never>;
  lookup_methods: ColumnType<unknown, string, never>;
  violations: ColumnType<unknown, string, never>;
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

/** An operator-kept mapping of a source system's local location code to a SATUSEHAT Location (#10). */
export interface LocationMappingTable {
  source_system_id: string;
  location_code: string;
  location_id: string;
  note: string | null;
  updated_at: Timestamp;
}

/** Every table, as Kysely sees it. */
export interface Database {
  case: CaseTable;
  step: StepTable;
  attempt: AttemptTable;
  source_event: SourceEventTable;
  idempotency_key: IdempotencyKeyTable;
  location_mapping: LocationMappingTable;
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
