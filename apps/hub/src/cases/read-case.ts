import type { Kysely } from 'kysely';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { CaseId, CaseStatus, DeadLetterReason, EventType, StepName, StepState, VisitId } from './case-model.js';

/** One step as the case view shows it. */
export interface StepView {
  step: StepName;
  eventType: EventType;
  state: StepState;
  /** How many times the step has been claimed. */
  attempts: number;
  /** Why the step was dead-lettered; null unless it was. */
  deadLetterReason: DeadLetterReason | null;
  /** The record the step's completion stored at SATUSEHAT; null until it completes. */
  remote: { type: string; id: string; version: string | null } | null;
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
  steps: StepView[];
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
        .select(['name', 'event_type', 'state', 'attempts', 'dead_letter_reason', 'remote_type', 'remote_id', 'remote_version'])
        .where('case_id', '=', caseId)
        .orderBy('seq')
        .execute();
      return {
        // Read back from the row this case's ids were written to.
        caseId: kase.id as CaseId,
        visitId: kase.visit_id as VisitId,
        status: kase.status,
        waitingFor: kase.waiting_for,
        waitingSince: kase.waiting_since?.toISOString() ?? null,
        steps: steps.map((s) => ({
          step: s.name,
          eventType: s.event_type,
          state: s.state,
          attempts: s.attempts,
          deadLetterReason: s.dead_letter_reason,
          remote:
            s.remote_type !== null && s.remote_id !== null
              ? { type: s.remote_type, id: s.remote_id, version: s.remote_version }
              : null,
        })),
      };
    });
}
