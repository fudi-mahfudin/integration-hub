import type { Transaction } from 'kysely';
import type { SourceSystem } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import type { ValidatedEvent } from '../ingestion/event-schema.js';
import { applyEventArrival, openingSteps, stepBySeq, stepForEvent, type DerivedStatus, type StepState } from './case-model.js';
import { readSteps, writeDerivedStatus } from './case-status.js';

export interface RecordedEvent {
  caseId: string;
  caseStatus: DerivedStatus['status'];
}

/**
 * Stores an accepted source event inside the caller's transaction: opens the
 * case keyed by (source, visitId) with all four steps if needed, stores the
 * event, releases or blocks its step and re-derives the case status (#8).
 * @throws Problem 409 `EVENT_ALREADY_RECORDED` when the case already has this event type.
 */
export async function recordEvent(
  trx: Transaction<Database>,
  source: SourceSystem,
  event: ValidatedEvent,
  now: Date,
): Promise<RecordedEvent> {
  const opened = await trx
    .insertInto('case')
    .values({
      source_id: source.id,
      organization_id: source.organizationId,
      visit_id: event.visitId,
      status: 'waiting',
      waiting_for: 'visit.started',
      waiting_since: now,
      opened_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.constraint('case_source_visit_key').doNothing())
    .returning(['id', 'status', 'waiting_for', 'waiting_since'])
    .executeTakeFirst();

  if (opened) {
    await trx
      .insertInto('step')
      .values(
        openingSteps().map((s) => ({
          case_id: opened.id,
          seq: s.seq,
          name: stepBySeq(s.seq).name,
          event_type: stepBySeq(s.seq).eventType,
          state: s.state,
          updated_at: now,
        })),
      )
      .execute();
  }

  const kase =
    opened ??
    (await trx
      .selectFrom('case')
      .select(['id', 'status', 'waiting_for', 'waiting_since'])
      .where('source_id', '=', source.id)
      .where('visit_id', '=', event.visitId)
      .forUpdate()
      .executeTakeFirstOrThrow());

  const stored = await trx
    .insertInto('source_event')
    .values({
      case_id: kase.id,
      type: event.type,
      occurred_at: event.occurredAt,
      envelope: JSON.stringify(event.envelope),
      received_at: now,
    })
    .onConflict((oc) => oc.constraint('source_event_case_type_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!stored) throw new Problem(409, 'EVENT_ALREADY_RECORDED');

  const seq = stepForEvent(event.type).seq;
  const after = applyEventArrival(await readSteps(trx, kase.id), seq);
  const newState = after.find((s) => s.seq === seq)?.state as StepState;
  await trx
    .updateTable('step')
    .set({ state: newState, updated_at: now })
    .where('case_id', '=', kase.id)
    .where('seq', '=', seq)
    .execute();

  const derived = await writeDerivedStatus(trx, kase, after, now);
  return { caseId: kase.id, caseStatus: derived.status };
}
