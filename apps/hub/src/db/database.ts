import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';

/** `timestamptz`: written as a Date, read back as a Date. */
type Timestamp = ColumnType<Date, Date, Date>;

export interface CaseTable {
  id: Generated<string>;
  source_id: string;
  organization_id: string;
  visit_id: string;
  status: string;
  waiting_for: string | null;
  waiting_since: Timestamp | null;
  opened_at: Timestamp;
  updated_at: Timestamp;
}

export interface StepTable {
  case_id: string;
  seq: number;
  name: string;
  event_type: string;
  state: string;
  updated_at: Timestamp;
  attempts: Generated<number>;
  lease_token: string | null;
  lease_expires_at: Timestamp | null;
  available_at: Timestamp | null;
  remote_type: string | null;
  remote_id: string | null;
  remote_version: string | null;
  dead_letter_reason: string | null;
  claimed_at: Timestamp | null;
  /** Values a completed step sent (#10); later steps read only these. */
  pins: ColumnType<Record<string, unknown> | null, string | null, string | null>;
}

/** Append-only: one row per finished attempt, never updated (#8, #28). */
export interface StepAttemptTable {
  case_id: string;
  seq: number;
  attempt: number;
  started_at: Timestamp;
  ended_at: Timestamp;
  outcome: 'completed' | 'dead_lettered' | 'retry_wait';
  error_code: string | null;
  http_status: number | null;
  used: ColumnType<Record<string, unknown>, string, never>;
  violations: ColumnType<unknown[], string, never>;
  detail: string | null;
}

export interface LocationMappingTable {
  source_id: string;
  location_code: string;
  /** SATUSEHAT Location id. */
  location_id: string;
  note: string | null;
  updated_at: Timestamp;
}

/** Ingest rejections by (source, visitId) (#8): code, event type and time only, never the body. */
export interface IngestRejectionTable {
  id: Generated<string>;
  source_id: string;
  visit_id: string;
  code: string;
  event_type: string | null;
  rejected_at: Timestamp;
}

export interface DrugMappingTable {
  source_id: string;
  /** The source's local drug code. */
  drug_code: string;
  kfa_code: string;
  note: string | null;
  updated_at: Timestamp;
}

/** KFA product details as KFA v2 gave them (#10); shared by all sources. */
export interface KfaProductTable {
  kfa_code: string;
  level: number;
  display: string;
  parent_92: string | null;
  ingredients: ColumnType<string[], string, string>;
  dose_form_code: string | null;
  dose_form_name: string | null;
  fetched_at: ColumnType<Date, Date | undefined, Date>;
}

export interface SourceEventTable {
  id: Generated<string>;
  case_id: string;
  type: string;
  occurred_at: Timestamp;
  envelope: ColumnType<unknown, string, string>;
  received_at: Timestamp;
}

export interface IdempotencyKeyTable {
  source_id: string;
  key: string;
  /** Hex SHA-256 of the RFC 8785 canonical body. */
  fingerprint: string;
  /** Null only inside the accepting transaction, before the response is known. */
  response_status: number | null;
  response_headers: ColumnType<Record<string, string> | null, string | null, string | null>;
  response_body: string | null;
  created_at: Timestamp;
}

/** Table types are added here as migrations create tables. */
export interface Database {
  case: CaseTable;
  step: StepTable;
  source_event: SourceEventTable;
  idempotency_key: IdempotencyKeyTable;
  location_mapping: LocationMappingTable;
  step_attempt: StepAttemptTable;
  ingest_rejection: IngestRejectionTable;
  drug_mapping: DrugMappingTable;
  kfa_product: KfaProductTable;
}

export function createDatabase(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
  });
}
