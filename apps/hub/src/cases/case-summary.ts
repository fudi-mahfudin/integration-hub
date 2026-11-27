import { sql, type Kysely } from 'kysely';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { CaseId, CaseStatus, DeadLetterReason, EventType, StepName, VisitId } from './case-model.js';
import { reasonClassOf, type ReasonClass } from './reason-class.js';

/** Which cases a read may see: one source system's, or, for the operator, every case. */
export type CaseScope = { sourceSystemId: SourceSystemId } | 'operator';

/** How `stalled` is judged: as of `now`, a waiting case is stalled once it has waited longer than `stalledAfterMs` (ADR 0007). */
export interface StallRule {
  now: Date;
  stalledAfterMs: number;
}

/** A waiting case is stalled when it has waited since before this instant. */
export function waitingStalledBefore(stall: StallRule): Date {
  return new Date(stall.now.getTime() - stall.stalledAfterMs);
}

/** A case in one row: what `GET /v1/cases` lists, and what `GET /v1/cases/{id}` starts with (#38). */
export interface CaseSummary {
  caseId: CaseId;
  /** The source system the case belongs to. */
  source: SourceSystemId;
  visitId: VisitId;
  status: CaseStatus;
  /** The earliest step not completed; null once the case has completed. */
  currentStep: StepName | null;
  /** The event a waiting case waits for; null unless `waiting`. */
  waitingFor: EventType | null;
  /** Since when a waiting case has waited for it, ISO 8601 UTC; null unless `waiting`. */
  waitingSince: string | null;
  /** Whether a waiting case has waited longer than the stalled threshold, as of the read (ADR 0007); it changes nothing about the case. */
  stalled: boolean;
  /** Why a dead-lettered case's failed step was dead-lettered; null unless `dead_lettered`. */
  deadLetterReason: DeadLetterReason | null;
  /** What an operator can do about `deadLetterReason` (#21); null unless `dead_lettered`. */
  reasonClass: ReasonClass | null;
  /** Since when a dead-lettered case has been dead-lettered, ISO 8601 UTC; null unless `dead_lettered`. */
  deadLetteredSince: string | null;
  /** How many times workers have claimed the case's steps, all four together. */
  attempts: number;
  /** When the case last changed (an accepted event, an attempt's outcome, a replay or an abandonment; a claim alone doesn't), ISO 8601 UTC. */
  updatedAt: string;
}

/**
 * The case summaries `scope` may see, as a query to narrow further. `db` may
 * be a transaction, so the case view reads its summary from its snapshot.
 */
export function selectCaseSummaries(db: Kysely<Database>, scope: CaseScope) {
  let query = db
    .selectFrom('case as c')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('step')
          .select('step.name')
          .whereRef('step.case_id', '=', 'c.id')
          .where('step.state', '<>', 'completed')
          .orderBy('step.seq')
          .limit(1)
          .as('current'),
      (join) => join.onTrue(),
    )
    .leftJoinLateral(
      // Only the current step can be dead-lettered, and only while the case is.
      (eb) =>
        eb
          .selectFrom('step')
          .select('step.dead_letter_reason')
          .whereRef('step.case_id', '=', 'c.id')
          .where('step.state', '=', 'dead_lettered')
          .limit(1)
          .as('failed'),
      (join) => join.onTrue(),
    )
    .select([
      'c.id',
      'c.list_seq',
      'c.source_system_id',
      'c.visit_id',
      'c.status',
      'c.waiting_for',
      'c.waiting_since',
      'c.dead_lettered_since',
      'c.updated_at',
      'current.name as current_step',
      'failed.dead_letter_reason',
      sql<number>`(select coalesce(sum(s.attempts), 0)::int from step s where s.case_id = c.id)`.as('attempts'),
    ]);
  if (scope !== 'operator') query = query.where('c.source_system_id', '=', scope.sourceSystemId);
  return query;
}

/** A row `selectCaseSummaries` reads. */
type SummaryRow = Awaited<ReturnType<ReturnType<typeof selectCaseSummaries>['execute']>>[number];

/** The summary a `selectCaseSummaries` row shows, with `stalled` judged by `stall`. */
export function toCaseSummary(row: SummaryRow, stall: StallRule): CaseSummary {
  const deadLetterReason = row.status === 'dead_lettered' ? row.dead_letter_reason : null;
  return {
    // Read back from the row this case's ids were written to.
    caseId: row.id as CaseId,
    source: row.source_system_id as SourceSystemId,
    visitId: row.visit_id as VisitId,
    status: row.status,
    currentStep: row.current_step,
    waitingFor: row.waiting_for,
    waitingSince: row.waiting_since?.toISOString() ?? null,
    stalled: row.status === 'waiting' && row.waiting_since !== null && row.waiting_since < waitingStalledBefore(stall),
    deadLetterReason,
    reasonClass: deadLetterReason === null ? null : reasonClassOf(deadLetterReason),
    deadLetteredSince: row.status === 'dead_lettered' ? (row.dead_lettered_since?.toISOString() ?? null) : null,
    attempts: row.attempts,
    updatedAt: row.updated_at.toISOString(),
  };
}
