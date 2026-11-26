import type { Kysely } from 'kysely';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { EventType, VisitId } from './case-model.js';

/**
 * The ingest rejection codes the rejection log keeps (#8): the ones that
 * judged a visit's event. Rejections that never got that far
 * (authentication, the `Idempotency-Key` header, a key reused for another
 * body) are not about the visit and are not logged.
 */
export const REJECTION_CODES = ['VALIDATION_FAILED', 'UNSUPPORTED_MULTI_ITEM', 'EVENT_ALREADY_RECORDED'] as const;

/** A code the rejection log keeps. */
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Whether an ingest problem's code is one the rejection log keeps. */
export function isLoggedRejection(code: string): code is RejectionCode {
  return (REJECTION_CODES as readonly string[]).includes(code);
}

/** One logged rejection as the case view shows it. */
export interface RejectionView {
  code: RejectionCode;
  eventType: EventType;
  /** ISO 8601 UTC. */
  rejectedAt: string;
}

/** The visit and event type a rejected event named. */
export interface RejectedEvent {
  sourceSystemId: SourceSystemId;
  visitId: VisitId;
  eventType: EventType;
}

/**
 * Appends a rejection to the log keyed by (source system, visitId): code,
 * event type and time, never the body. It is written on its own, apart from
 * the rejected request's rolled-back transaction, and changes no case.
 */
export async function logRejection(db: Kysely<Database>, event: RejectedEvent, code: RejectionCode, at: Date): Promise<void> {
  await db
    .insertInto('rejection')
    .values({ source_system_id: event.sourceSystemId, visit_id: event.visitId, event_type: event.eventType, code, rejected_at: at })
    .execute();
}

/** A visit's logged rejections, oldest first. `db` may be a transaction, so the case view reads them from its snapshot. */
export async function readRejections(db: Kysely<Database>, sourceSystemId: SourceSystemId, visitId: VisitId): Promise<RejectionView[]> {
  const rows = await db
    .selectFrom('rejection')
    .select(['code', 'event_type', 'rejected_at'])
    .where('source_system_id', '=', sourceSystemId)
    .where('visit_id', '=', visitId)
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ code: r.code, eventType: r.event_type, rejectedAt: r.rejected_at.toISOString() }));
}
