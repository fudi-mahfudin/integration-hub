import type { Transaction } from 'kysely';
import type { Database } from '../db/database.js';
import { deriveStatus, type DerivedStatus, type StepState, type StepView } from './case-model.js';

/** A case's steps, read inside the caller's transaction. */
export async function readSteps(trx: Transaction<Database>, caseId: string): Promise<StepView[]> {
  const rows = await trx.selectFrom('step').select(['seq', 'state']).where('case_id', '=', caseId).orderBy('seq').execute();
  return rows.map((s) => ({ seq: s.seq, state: s.state as StepState }));
}

/**
 * Stores the case status derived from `steps` (#8), in the same transaction as
 * the step change. `waiting_since` is kept while the case keeps waiting for
 * the same event, and restarts when it starts waiting for another.
 */
export async function writeDerivedStatus(
  trx: Transaction<Database>,
  kase: { id: string; waiting_for: string | null; waiting_since: Date | null },
  steps: readonly StepView[],
  now: Date,
): Promise<DerivedStatus> {
  const derived = deriveStatus(steps);
  const stillWaitingForSame = derived.status === 'waiting' && derived.waitingFor === kase.waiting_for;
  await trx
    .updateTable('case')
    .set({
      status: derived.status,
      waiting_for: derived.waitingFor,
      waiting_since: derived.status !== 'waiting' ? null : stillWaitingForSame ? kase.waiting_since : now,
      updated_at: now,
    })
    .where('id', '=', kase.id)
    .execute();
  return derived;
}
