import type { Kysely } from 'kysely';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { AttemptOutcome, Database } from '../db/database.js';
import { readPins, type StepPins } from './pins.js';
import { readRejections, type RejectionView } from './rejection-log.js';
import type {
  CaseId,
  CaseStatus,
  DeadLetterReason,
  EventType,
  RemoteId,
  RemoteIdentifier,
  StepName,
  StepState,
  VisitId,
} from './case-model.js';

/** One step as the case view shows it. */
export interface CaseStepView {
  step: StepName;
  eventType: EventType;
  state: StepState;
  /** How many times the step has been claimed. */
  attempts: number;
  /** Why the step was dead-lettered; null unless it was. */
  deadLetterReason: DeadLetterReason | null;
  /** The record the step's completion stored at SATUSEHAT; null until it completes. */
  remote: RemoteIdentifier | null;
  /** The values the step's completion pinned; null until it completes. */
  pins: StepPins | null;
  /** Every attempt at the step, oldest first. */
  attemptLog: AttemptView[];
}

/** One row of a step's attempt log as the case view shows it. */
export interface AttemptView {
  attempt: number;
  /** ISO 8601 UTC. */
  startedAt: string;
  /** ISO 8601 UTC. */
  endedAt: string;
  outcome: AttemptOutcome;
  /** The dead-letter reason the attempt reached; null otherwise. */
  errorCode: DeadLetterReason | null;
  httpStatus: number | null;
  valuesUsed: unknown;
  lookupMethods: unknown;
  violations: unknown;
}

/** A case as `GET /v1/cases/{id}` shows it: its status, what a waiting case waits for, and its steps in order. */
export interface CaseView {
  caseId: CaseId;
  visitId: VisitId;
  status: CaseStatus;
  /** The event a waiting case waits for; null unless `waiting`. */
  waitingFor: EventType | null;
  /** Since when a waiting case has waited for it, ISO 8601 UTC; null unless `waiting`. */
  waitingSince: string | null;
  /** The visit's ingest rejections, oldest first; they explain a waiting case and never change it (#8). */
  rejections: RejectionView[];
  steps: CaseStepView[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads one case of one source system, or `undefined` when that source system
 * has no case with this id (any string is accepted; a non-uuid finds nothing).
 * Reads case and steps from one snapshot, so a step change committing between
 * the two reads can't show under the old case status.
 */
export async function readCase(
  db: Kysely<Database>,
  sourceSystemId: SourceSystemId,
  caseId: string,
): Promise<CaseView | undefined> {
  if (!UUID.test(caseId)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const kase = await trx
        .selectFrom('case')
        .select(['id', 'visit_id', 'status', 'waiting_for', 'waiting_since'])
        .where('id', '=', caseId)
        .where('source_system_id', '=', sourceSystemId)
        .executeTakeFirst();
      if (!kase) return undefined;
      const steps = await trx
        .selectFrom('step')
        .select(['seq', 'name', 'event_type', 'state', 'attempts', 'dead_letter_reason', 'remote_type', 'remote_id', 'remote_version', 'pins'])
        .where('case_id', '=', caseId)
        .orderBy('seq')
        .execute();
      const attempts = await trx
        .selectFrom('attempt')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('seq')
        .orderBy('attempt')
        .execute();
      // Read back from the row this case's visit id was written to.
      const rejections = await readRejections(trx, sourceSystemId, kase.visit_id as VisitId);
      return {
        // Read back from the row this case's ids were written to.
        caseId: kase.id as CaseId,
        visitId: kase.visit_id as VisitId,
        status: kase.status,
        waitingFor: kase.waiting_for,
        waitingSince: kase.waiting_since?.toISOString() ?? null,
        rejections,
        steps: steps.map((s) => ({
          step: s.name,
          eventType: s.event_type,
          state: s.state,
          attempts: s.attempts,
          deadLetterReason: s.dead_letter_reason,
          remote:
            s.remote_type !== null && s.remote_id !== null
              ? // Stored only by lease-fenced completion, from a RemoteIdentifier.
                { type: s.remote_type, id: s.remote_id as RemoteId, version: s.remote_version }
              : null,
          pins: s.pins === null ? null : readPins(s.name, s.pins),
          attemptLog: attempts
            .filter((a) => a.seq === s.seq)
            .map((a) => ({
              attempt: a.attempt,
              startedAt: a.started_at.toISOString(),
              endedAt: a.ended_at.toISOString(),
              outcome: a.outcome,
              errorCode: a.error_code,
              httpStatus: a.http_status,
              // Written by the outbox from an attempt's facts, as JSON; shown as stored.
              valuesUsed: a.values_used,
              lookupMethods: a.lookup_methods,
              violations: a.violations,
            })),
        })),
      };
    });
}
