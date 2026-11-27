import type { Kysely } from 'kysely';
import type { AttemptOutcome, Database } from '../db/database.js';
import { readCaseDivergences, type DivergenceView } from '../reconciliation/runs.js';
import { selectCaseSummaries, toCaseSummary, type CaseScope, type CaseSummary, type StallRule } from './case-summary.js';
import type { RemoteRecordLeft } from './operator-actions.js';
import { readPins, type StepPins } from './pins.js';
import { readRejections, type RejectionView } from './rejection-log.js';
import type { CaseId, DeadLetterReason, EventType, RemoteId, RemoteIdentifier, StepName, StepState } from './case-model.js';

/** One step as the case view shows it. */
export interface CaseStepView {
  step: StepName;
  eventType: EventType;
  state: StepState;
  /** How many times the step has been claimed. */
  attempts: number;
  /** Why the step was dead-lettered; null unless it was. */
  deadLetterReason: DeadLetterReason | null;
  /** When a `retry_wait` step may be claimed again, ISO 8601 UTC; null otherwise. */
  availableAt: string | null;
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
  /** The attempt's in-process read retries: sub-entries, not attempts (#13). */
  readRetries: unknown;
}

/** One operator replay as the case view shows it. */
export interface ReplayView {
  /** The step replayed: the one that was dead-lettered. */
  step: StepName;
  /** The dead-letter reason the replay cleared. */
  reason: DeadLetterReason;
  /** The operator's note, if they gave one. */
  note: string | null;
  /** ISO 8601 UTC. */
  replayedAt: string;
}

/** An abandonment as the case view shows it. */
export interface AbandonmentView {
  /** The operator's required note: why the case can never complete. */
  note: string;
  /** ISO 8601 UTC. */
  abandonedAt: string;
  previousStatus: 'waiting' | 'dead_lettered';
  /** What the case waited for, if it was waiting. */
  waitingFor: EventType | null;
  /** Why the case was dead-lettered, if it was. */
  deadLetterReason: DeadLetterReason | null;
  /** The records its completed steps left at SATUSEHAT. */
  remoteRecordsLeft: RemoteRecordLeft[];
}

/** One accepted source event of the case, as the case view shows it (#38). */
export interface EventView {
  type: EventType;
  /** When the hub accepted it, ISO 8601 UTC. */
  receivedAt: string;
  /** The trace of its ingest; null until the hub records traces. */
  traceId: string | null;
  /** How many duplicate ingests got its original `202`. */
  duplicates: number;
}

/** A case as `GET /v1/cases/{id}` shows it: its summary row, what the operator did, its events and its steps in order. */
export interface CaseView extends CaseSummary {
  /** How many times an operator has replayed the case (#37). */
  replayCount: number;
  /** The operator's replays of the case, oldest first (#37). */
  replays: ReplayView[];
  /** The operator's abandonment of the case; null unless `abandoned` (ADR 0007). */
  abandonment: AbandonmentView | null;
  /** The visit's ingest rejections, oldest first; they explain a waiting case and never change it (#8). */
  rejections: RejectionView[];
  /** The case's accepted source events, in the order the hub accepted them (#38). */
  events: EventView[];
  /** What the latest completed reconciliation run that covered the case found different at SATUSEHAT (#39); empty when none did. */
  divergences: DivergenceView[];
  steps: CaseStepView[];
}

/** A case id's shape; any other string names no case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads one case in `scope`, or `undefined` when there is no such case in it
 * (any string is accepted; a non-uuid finds nothing). `stalled` is computed
 * against `now`: a waiting case is stalled once it has waited longer than
 * `stalledAfterMs`.
 * Reads case and steps from one snapshot, so a step change committing between
 * the two reads can't show under the old case status.
 */
export async function readCase(
  db: Kysely<Database>,
  scope: CaseScope,
  caseId: string,
  stall: StallRule,
): Promise<CaseView | undefined> {
  if (!UUID.test(caseId)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const row = await selectCaseSummaries(trx, scope).where('c.id', '=', caseId).executeTakeFirst();
      if (!row) return undefined;
      const summary = toCaseSummary(row, stall);
      const steps = await trx
        .selectFrom('step')
        .select(['seq', 'name', 'event_type', 'state', 'attempts', 'dead_letter_reason', 'available_at', 'remote_type', 'remote_id', 'remote_version', 'pins'])
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
      const replays = await trx.selectFrom('replay').select(['seq', 'reason', 'note', 'replayed_at']).where('case_id', '=', caseId).orderBy('id').execute();
      const abandonment = await trx.selectFrom('abandonment').selectAll().where('case_id', '=', caseId).executeTakeFirst();
      const events = await trx
        .selectFrom('source_event')
        .select(['type', 'received_at', 'duplicates'])
        .where('case_id', '=', caseId)
        .orderBy('received_at')
        .orderBy('id')
        .execute();
      const rejections = await readRejections(trx, summary.source, summary.visitId);
      // The case just read under this id.
      const divergences = await readCaseDivergences(trx, caseId as CaseId);
      const nameOf = (seq: number) => {
        const step = steps.find((s) => s.seq === seq);
        if (!step) throw new Error(`case ${caseId} has no step ${seq}`);
        return step.name;
      };
      return {
        ...summary,
        replayCount: replays.length,
        replays: replays.map((r) => ({ step: nameOf(r.seq), reason: r.reason, note: r.note, replayedAt: r.replayed_at.toISOString() })),
        abandonment: abandonment
          ? {
              note: abandonment.note,
              abandonedAt: abandonment.abandoned_at.toISOString(),
              previousStatus: abandonment.previous_status,
              waitingFor: abandonment.waiting_for,
              deadLetterReason: abandonment.dead_letter_reason,
              // Written by abandonCase from the case's completed steps, as JSON; shown as stored.
              remoteRecordsLeft: abandonment.remote_records_left as RemoteRecordLeft[],
            }
          : null,
        rejections,
        events: events.map((e) => ({ type: e.type, receivedAt: e.received_at.toISOString(), traceId: null, duplicates: e.duplicates })),
        divergences,
        steps: steps.map((s) => ({
          step: s.name,
          eventType: s.event_type,
          state: s.state,
          attempts: s.attempts,
          deadLetterReason: s.dead_letter_reason,
          availableAt: s.available_at?.toISOString() ?? null,
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
              readRetries: a.read_retries,
            })),
        })),
      };
    });
}
