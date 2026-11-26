import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.js';
import { deriveStatus, waitingFor, type CaseStatus, type StepView } from './case-model.js';

/**
 * Stores the case status derived from `steps`, with what a waiting case waits
 * for (#8). Call it in the transaction that changed the steps, holding the
 * case row lock. `waiting_since` keeps its value while the case keeps waiting
 * for the same event.
 */
export async function writeCaseStatus(
  trx: Transaction<Database>,
  caseId: string,
  steps: readonly StepView[],
  now: Date,
): Promise<CaseStatus> {
  const status = deriveStatus(steps);
  const waitingForEvent = waitingFor(steps);
  await trx
    .updateTable('case')
    .set({
      status,
      waiting_for: waitingForEvent,
      waiting_since:
        waitingForEvent === null
          ? null
          : sql<Date>`case when waiting_for = ${waitingForEvent} then waiting_since else ${now}::timestamptz end`,
      updated_at: now,
    })
    .where('id', '=', caseId)
    .execute();
  return status;
}

/** A case's steps, as the state machine sees them. */
export async function readSteps(trx: Transaction<Database>, caseId: string): Promise<StepView[]> {
  return trx.selectFrom('step').select(['seq', 'state']).where('case_id', '=', caseId).orderBy('seq').execute();
}
