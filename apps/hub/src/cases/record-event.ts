import type { Transaction } from 'kysely';
import type { SourceSystem } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import { Problem, type FieldError } from '../http/problem.js';
import {
  applyEventArrival,
  deriveStatus,
  openingSteps,
  STEPS,
  stepForEvent,
  type CaseId,
  type CaseStatus,
  type PrescriptionId,
  type PrescriptionItemId,
  type VisitId,
} from './case-model.js';
import { readSteps, writeCaseStatus } from './case-status.js';

/** A prescription's one drug item, by the identifiers the source gave them (#6). */
export interface PrescriptionItemKey {
  prescriptionId: PrescriptionId;
  itemId: PrescriptionItemId;
}

/** A source event that passed its schema, ready to be recorded against its visit. */
export type AcceptedEvent = {
  visitId: VisitId;
  occurredAt: Date;
  /** The envelope as received, stored with the event. */
  envelope: unknown;
} & (
  | { type: 'visit.started'; prescriptionItem: null }
  | { type: 'prescription.written' | 'drug.dispensed'; prescriptionItem: PrescriptionItemKey }
);

/** Where a recorded event landed. */
export interface RecordedEvent {
  caseId: CaseId;
  caseStatus: CaseStatus;
}

/**
 * Records an accepted source event inside the caller's transaction: opens the
 * case keyed by (source system, visitId) with all four step rows if needed,
 * stores the event, releases or blocks its step, and stores the re-derived
 * case status (#8). The released step is the outbox entry (ADR 0002): it
 * becomes claimable when this transaction commits.
 * @throws Problem `EVENT_ALREADY_RECORDED` (409) when the case already has an event of this type.
 * @throws Problem `UNSUPPORTED_MULTI_ITEM` (422) when the case already has a prescription with another item (ADR 0004).
 * @throws Problem `PRESCRIPTION_MISMATCH` (422) when the other event of the prescription/dispense pair is recorded
 *   with another `prescriptionId` or `itemId` (#6).
 */
export async function recordEvent(
  trx: Transaction<Database>,
  source: SourceSystem,
  event: AcceptedEvent,
  now: Date,
): Promise<RecordedEvent> {
  // Insert-or-nothing on the (source, visit) constraint: a concurrent opener
  // waits on the unique index until the first commits, then finds its case.
  const opened = await trx
    .insertInto('case')
    .values({
      source_system_id: source.id,
      organization_id: source.organizationId,
      visit_id: event.visitId,
      // Overwritten below, once the event's step is applied.
      status: deriveStatus(openingSteps()),
      opened_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.constraint('case_source_system_visit_key').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (opened) {
    await trx
      .insertInto('step')
      .values(
        STEPS.map((s) => ({
          case_id: opened.id,
          seq: s.seq,
          name: s.name,
          event_type: s.eventType,
          state: 'awaiting_event' as const,
          updated_at: now,
        })),
      )
      .execute();
  }

  // Lock the case so concurrent events for the same visit apply one at a time.
  const { id } =
    opened ??
    (await trx
      .selectFrom('case')
      .select('id')
      .where('source_system_id', '=', source.id)
      .where('visit_id', '=', event.visitId)
      .forUpdate()
      .executeTakeFirstOrThrow());

  const stored = await trx
    .insertInto('source_event')
    .values({
      case_id: id,
      type: event.type,
      occurred_at: event.occurredAt,
      envelope: JSON.stringify(event.envelope),
      prescription_id: event.prescriptionItem?.prescriptionId ?? null,
      item_id: event.prescriptionItem?.itemId ?? null,
      received_at: now,
    })
    .onConflict((oc) => oc.constraint('source_event_case_type_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!stored) throw await alreadyRecorded(trx, id, event);
  if (event.prescriptionItem) await checkPair(trx, id, event.type, event.prescriptionItem);

  const steps = await readSteps(trx, id);
  const seq = stepForEvent(event.type).seq;
  const after = applyEventArrival(steps, seq);
  const arrived = after.find((s) => s.seq === seq);
  if (!arrived) throw new Error(`case ${id} has no step ${seq}`);
  await trx
    .updateTable('step')
    .set({ state: arrived.state, updated_at: now })
    .where('case_id', '=', id)
    .where('seq', '=', seq)
    .execute();

  const caseStatus = await writeCaseStatus(trx, id, after, now);
  // Postgres generated this uuid for the case; it is a case id by construction.
  return { caseId: id as CaseId, caseStatus };
}

/**
 * The cross-event check of #6 (amended by #9): when the second event of the
 * prescription/dispense pair arrives, it must name the prescription and item
 * the first one did. Throwing rolls back the event just stored.
 */
async function checkPair(
  trx: Transaction<Database>,
  caseId: string,
  type: 'prescription.written' | 'drug.dispensed',
  item: PrescriptionItemKey,
): Promise<void> {
  const other = await trx
    .selectFrom('source_event')
    .select(['prescription_id', 'item_id'])
    .where('case_id', '=', caseId)
    .where('type', '=', type === 'prescription.written' ? 'drug.dispensed' : 'prescription.written')
    .executeTakeFirst();
  if (!other) return;
  const otherName = type === 'prescription.written' ? 'the dispense' : 'the prescription';
  const errors: FieldError[] = [];
  if (other.prescription_id !== item.prescriptionId) {
    errors.push({
      path: '/data/prescriptionId',
      code: 'PRESCRIPTION_MISMATCH',
      message: `must be "${other.prescription_id}", the prescriptionId ${otherName} recorded for this visit named`,
    });
  }
  if (other.item_id !== item.itemId) {
    errors.push({
      path: type === 'prescription.written' ? '/data/items/0/itemId' : '/data/itemId',
      code: 'PRESCRIPTION_MISMATCH',
      message: `must be "${other.item_id}", the itemId ${otherName} recorded for this visit named`,
    });
  }
  if (errors.length > 0) throw new Problem('PRESCRIPTION_MISMATCH', errors);
}

/**
 * Why an event of a type the case already has is rejected: a prescription
 * with another prescription or item is a second drug item for the visit
 * (`UNSUPPORTED_MULTI_ITEM`, #6); anything else is `EVENT_ALREADY_RECORDED`.
 */
async function alreadyRecorded(trx: Transaction<Database>, caseId: string, event: AcceptedEvent): Promise<Problem> {
  if (event.type !== 'prescription.written') return new Problem('EVENT_ALREADY_RECORDED', []);
  const recorded = await trx
    .selectFrom('source_event')
    .select(['prescription_id', 'item_id'])
    .where('case_id', '=', caseId)
    .where('type', '=', 'prescription.written')
    .executeTakeFirstOrThrow();
  const { prescriptionId, itemId } = event.prescriptionItem;
  if (recorded.prescription_id === prescriptionId && recorded.item_id === itemId) return new Problem('EVENT_ALREADY_RECORDED', []);
  return new Problem('UNSUPPORTED_MULTI_ITEM', [
    {
      path: '/data/items/0/itemId',
      code: 'UNSUPPORTED_MULTI_ITEM',
      message: 'the visit already has a prescription with another prescriptionId or itemId; a case supports one drug item',
    },
  ]);
}
