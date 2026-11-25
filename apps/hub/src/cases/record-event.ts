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
 * @throws Problem 409 `EVENT_ALREADY_RECORDED` when the case already has this event type;
 *   422 `UNSUPPORTED_MULTI_ITEM` when it is a prescription for another item (#6).
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
  if (!stored) throw await alreadyRecorded(trx, kase.id, event);

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

/**
 * The rejection for a second event of a type the case already has: a
 * prescription naming another (prescriptionId, itemId) would make the visit
 * multi-item (#6, ADR 0004); anything else is the same event again.
 */
async function alreadyRecorded(trx: Transaction<Database>, caseId: string, event: ValidatedEvent): Promise<Problem> {
  if (event.type === 'prescription.written') {
    const row = await trx
      .selectFrom('source_event')
      .select('envelope')
      .where('case_id', '=', caseId)
      .where('type', '=', event.type)
      .executeTakeFirstOrThrow();
    if (prescriptionItemKey(row.envelope) !== prescriptionItemKey(event.envelope)) {
      return new Problem(422, 'UNSUPPORTED_MULTI_ITEM', [
        { path: '/data/items', code: 'UNSUPPORTED_MULTI_ITEM', message: 'the visit already has a prescription for another item' },
      ]);
    }
  }
  return new Problem(409, 'EVENT_ALREADY_RECORDED');
}

function prescriptionItemKey(envelope: unknown): string {
  const data = (envelope as { data: { prescriptionId: string; items: { itemId: string }[] } }).data;
  return JSON.stringify([data.prescriptionId, data.items[0]?.itemId]);
}
