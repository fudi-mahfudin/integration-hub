import type { Kysely } from 'kysely';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { CaseStatus, EventType, StepName, StepState } from './case-model.js';

/** A case as `GET /v1/cases/{id}` shows it: its status and its step states, in order. */
export interface CaseView {
  caseId: string;
  visitId: string;
  status: CaseStatus;
  steps: { step: StepName; eventType: EventType; state: StepState }[];
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
        .select(['id', 'visit_id', 'status'])
        .where('id', '=', caseId)
        .where('source_system_id', '=', sourceSystemId)
        .executeTakeFirst();
      if (!kase) return undefined;
      const steps = await trx
        .selectFrom('step')
        .select(['name', 'event_type', 'state'])
        .where('case_id', '=', caseId)
        .orderBy('seq')
        .execute();
      return {
        caseId: kase.id,
        visitId: kase.visit_id,
        status: kase.status,
        steps: steps.map((s) => ({ step: s.name, eventType: s.event_type, state: s.state })),
      };
    });
}
