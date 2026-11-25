import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { ClaimedStep, Pins, RemoteIdentifier } from '../outbox/outbox.js';
import type { FhirClient, KfaClient } from '../satusehat/fhir-client.js';
import type { Clock } from '../tokens.js';
import { deadLetterReason, validateStep, type StepCheck, type Violation } from '../validation/validation.js';

/** A permanent failure: the step dead-letters with this stable reason code (#8, #9). */
export type DeadLettered = { outcome: 'dead_lettered'; reason: string; violations?: Violation[] };

/**
 * What a step attempt ended with. A failure is a thrown error instead: the
 * worker dead-letters a permanent platform rejection (`permanentReason`) and
 * retries anything else.
 */
export type StepResult =
  /** `pins`: the values it sent, stored with the remote identifier (#10). */
  | { outcome: 'completed'; remote: RemoteIdentifier; pins: Pins }
  | DeadLettered;

export interface StepDeps {
  db: Kysely<Database>;
  /** Already observed by the worker: every answer's status reaches the attempt log. */
  fhir: FhirClient;
  /** KFA v2, observed like `fhir`. */
  kfa: KfaClient;
  clock: Clock;
}

/** The attempt in progress. */
export interface Attempt {
  /**
   * Put every value the attempt resolves here as soon as it has it (location
   * id, IHS numbers with their lookup method, KFA codes): it goes to the
   * attempt log whatever the outcome, a thrown error included.
   */
  used: Record<string, unknown>;
}

/** One step's attempt: resolve what it needs, validate, then search-then-create (ADR 0005). */
export type StepRunner = (step: ClaimedStep, deps: StepDeps, attempt: Attempt) => Promise<StepResult>;

/**
 * Runs the Validation module on what the step is about to send. Undefined
 * when it may be sent; otherwise the dead-letter with the first violation's
 * code and every violation (for the attempt log).
 */
export function checkStep(check: StepCheck): DeadLettered | undefined {
  const violations = validateStep(check);
  const reason = deadLetterReason(violations);
  return reason === undefined ? undefined : { outcome: 'dead_lettered', reason, violations };
}

/**
 * The pins of a completed step of this case (#10). Later steps read the
 * values earlier steps sent from here, never from the live mappings.
 */
export async function stepPins<T extends Pins>(db: Kysely<Database>, caseId: string, stepName: string): Promise<T> {
  return (await completedStep<T>(db, caseId, stepName)).pins;
}

/** A completed step of this case: its pins and its remote identifier (e.g. the visit's Encounter id). */
export async function completedStep<T extends Pins>(
  db: Kysely<Database>,
  caseId: string,
  stepName: string,
): Promise<{ pins: T; remote: RemoteIdentifier }> {
  const row = await db
    .selectFrom('step')
    .select(['pins', 'remote_type', 'remote_id', 'remote_version'])
    .where('case_id', '=', caseId)
    .where('name', '=', stepName)
    .where('state', '=', 'completed')
    .executeTakeFirstOrThrow();
  if (row.pins === null || row.remote_type === null || row.remote_id === null) {
    throw new Error(`completed step ${stepName} of case ${caseId} has no pins or remote identifier`);
  }
  return { pins: row.pins as T, remote: { type: row.remote_type, id: row.remote_id, version: row.remote_version } };
}

/** The source event envelope a step works from (stored by ingest, immutable). */
export async function sourceEvent(db: Kysely<Database>, caseId: string, type: string): Promise<Record<string, any>> {
  const row = await db
    .selectFrom('source_event')
    .select('envelope')
    .where('case_id', '=', caseId)
    .where('type', '=', type)
    .executeTakeFirstOrThrow();
  return row.envelope as Record<string, any>;
}

/**
 * Search-then-create (ADR 0005): exactly one match is adopted, none is
 * created (with `body`, already validated by `checkStep`), more than one
 * dead-letters (`REMOTE_RECORD_AMBIGUOUS`).
 */
export async function searchThenCreate(
  fhir: FhirClient,
  type: string,
  identifier: { system: string; value: string },
  body: Record<string, unknown>,
): Promise<{ outcome: 'completed'; remote: RemoteIdentifier } | DeadLettered> {
  const hits = await fhir.search(type, { identifier: `${identifier.system}|${identifier.value}` });
  if (hits.length > 1) return { outcome: 'dead_lettered', reason: 'REMOTE_RECORD_AMBIGUOUS' };
  const record = hits[0] ?? (await fhir.create(type, body));
  return { outcome: 'completed', remote: { type, id: record.id, version: record.meta?.versionId ?? null } };
}
