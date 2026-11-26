import type { Transaction } from 'kysely';
import type { SourceSystem } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import {
  applyEventArrival,
  deriveStatus,
  openingSteps,
  STEPS,
  stepForEvent,
  type CaseId,
  type CaseStatus,
  type EventType,
  type VisitId,
} from './case-model.js';
import { readSteps, writeCaseStatus } from './case-status.js';

/** A source event that passed its schema, ready to be recorded against its visit. */
export interface AcceptedEvent {
  type: EventType;
  visitId: VisitId;
  occurredAt: Date;
  /** The envelope as received, stored with the event. */
  envelope: unknown;
}

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
      received_at: now,
    })
    .onConflict((oc) => oc.constraint('source_event_case_type_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!stored) throw new Problem('EVENT_ALREADY_RECORDED', []);

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
