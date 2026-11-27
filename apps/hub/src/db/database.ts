import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';
import type { CaseStatus, DeadLetterReason, EventType, RemoteIdentifier, StepName, StepState } from '../cases/case-model.js';
import type { RejectionCode } from '../cases/rejection-log.js';
import type { DivergenceClass, ReconciliationCheckOutcome, ReconciliationRunStatus } from '../reconciliation/model.js';

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
  /** Since when a `dead_lettered` case has been dead-lettered; null otherwise (#37). */
  dead_lettered_since: Timestamp | null;
  opened_at: Timestamp;
  updated_at: Timestamp;
  /** Given once at insert, never changed: the case list's order and cursor (#38). Read as a string (`bigint`). */
  list_seq: ColumnType<string, never, never>;
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
  /** When the current claim was taken: its attempt's start; null unless `in_flight`. */
  claimed_at: Timestamp | null;
  /** From when a `retry_wait` step is claimable again; null otherwise. */
  available_at: Timestamp | null;
  /** The record the step's completion stored at SATUSEHAT. */
  remote_type: RemoteIdentifier['type'] | null;
  remote_id: string | null;
  remote_version: string | null;
  dead_letter_reason: DeadLetterReason | null;
  /** How many of `attempts` came before the step's last replay: the attempt cap counts only the rest (#37). */
  attempts_before_replay: Generated<number>;
  /** When the step was last replayed; KFA details fetched before then are fetched again (#10). */
  replayed_at: Timestamp | null;
  /** The values a completed step sent (#10); null until it completes. Read through `cases/pins.ts`. */
  pins: ColumnType<unknown, string | null, string | null>;
  updated_at: Timestamp;
}

/**
 * How an attempt ended. `failed`: it ended without an outcome. `lease_expired`:
 * its lease ran out before it stored an outcome, and another claim took the
 * step over (#8). `attempt_budget_exceeded`: it had less time left than one
 * call may take, so it stopped (#13). `discarded`: no longer written; rows
 * logged before #34 for an attempt whose late outcome the lease fence threw away.
 * `failed` and `attempt_budget_exceeded` are transient: the step waits in
 * `retry_wait`, unless it was the last attempt allowed.
 */
export type AttemptOutcome = 'completed' | 'dead_lettered' | 'discarded' | 'failed' | 'lease_expired' | 'attempt_budget_exceeded';

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
  /** The attempt's read retries, as JSON `ReadRetry[]`: sub-entries, not attempts (#13). */
  read_retries: ColumnType<unknown, string, never>;
}

/** An accepted source event, stored as received (after schema validation). */
export interface SourceEventTable {
  id: Generated<string>;
  case_id: string;
  type: EventType;
  occurred_at: Timestamp;
  envelope: ColumnType<unknown, string, never>;
  /** For a `prescription.written` or `drug.dispensed`: the `prescriptionId` and `itemId` it names; null for other types. */
  prescription_id: string | null;
  item_id: string | null;
  /** For a `visit.started` its `startedAt`, for a `visit.finished` its `finishedAt`; null for other types. */
  visit_time: Timestamp | null;
  received_at: Timestamp;
  /** How many duplicate ingests got the event's original `202` (#38). */
  duplicates: Generated<number>;
  /** The W3C `traceparent` of the ingest span that accepted the event (#42); null when it was not traced. */
  traceparent: string | null;
}

/** One ingest rejection of a visit's event (#8): code, event type and time, never the body. */
export interface RejectionTable {
  id: Generated<string>;
  source_system_id: string;
  visit_id: string;
  event_type: EventType;
  code: RejectionCode;
  rejected_at: Timestamp;
}

/** An operator-kept mapping of a source system's local drug code to a KFA code (#10). */
export interface DrugMappingTable {
  source_system_id: string;
  drug_code: string;
  kfa_code: string;
  note: string | null;
  updated_at: Timestamp;
}

/** KFA details fetched from the KFA v2 API on first use, shared by every source system (#10). */
export interface KfaProductTable {
  code: string;
  display: string;
  level: number;
  parent_92: string | null;
  /** The 91 codes of its active ingredients, as a JSON array. */
  active_ingredients: ColumnType<unknown, string, string>;
  dose_form_code: string | null;
  dose_form_display: string | null;
  fetched_at: Timestamp;
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

/** One operator replay of a dead-lettered case (#37). */
export interface ReplayTable {
  id: Generated<string>;
  case_id: string;
  /** The step replayed: the one that was dead-lettered. */
  seq: number;
  /** The dead-letter reason the replay cleared. */
  reason: DeadLetterReason;
  note: string | null;
  replayed_at: Timestamp;
}

/** An operator's abandonment of a case (ADR 0007): its note, and what the case was left as. */
export interface AbandonmentTable {
  case_id: string;
  note: string;
  abandoned_at: Timestamp;
  previous_status: 'waiting' | 'dead_lettered';
  /** What a waiting case waited for; null otherwise. */
  waiting_for: EventType | null;
  /** Why a dead-lettered case was dead-lettered; null otherwise. */
  dead_letter_reason: DeadLetterReason | null;
  /** The records completed steps left at SATUSEHAT, as JSON. */
  remote_records_left: ColumnType<unknown, string, never>;
}

/** A reconciliation run (#39): requested by an operator or the schedule, executed by a worker under one advisory lock. */
export interface ReconciliationRunTable {
  id: Generated<string>;
  status: ReconciliationRunStatus;
  trigger: 'operator' | 'schedule';
  /** Only these cases; null for every case in the default scope. */
  case_ids: string[] | null;
  /** Only cases changed since then; null when not given. */
  since: Timestamp | null;
  requested_at: Timestamp;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  /** Why a `failed` run failed; null otherwise. */
  error: string | null;
}

/** One case a reconciliation run checked, and how the check ended (#39). */
export interface ReconciliationCheckTable {
  run_id: string;
  case_id: string;
  outcome: ReconciliationCheckOutcome;
  checked_at: Timestamp;
}

/** What a reconciliation run found on one case (#39), stored as a snapshot. */
export interface ReconciliationFindingTable {
  id: ColumnType<string, never, never>;
  run_id: string;
  case_id: string;
  kind: 'divergence' | 'skipped' | 'unchecked';
  class: DivergenceClass | null;
  step: StepName | null;
  resource_type: RemoteIdentifier['type'] | null;
  field: string | null;
  snapshot: ColumnType<unknown, string, never>;
}

/** Every table, as Kysely sees it. */
export interface Database {
  case: CaseTable;
  step: StepTable;
  attempt: AttemptTable;
  source_event: SourceEventTable;
  idempotency_key: IdempotencyKeyTable;
  location_mapping: LocationMappingTable;
  rejection: RejectionTable;
  drug_mapping: DrugMappingTable;
  kfa_product: KfaProductTable;
  replay: ReplayTable;
  abandonment: AbandonmentTable;
  reconciliation_runs: ReconciliationRunTable;
  reconciliation_checks: ReconciliationCheckTable;
  reconciliation_findings: ReconciliationFindingTable;
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
