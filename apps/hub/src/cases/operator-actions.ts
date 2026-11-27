import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import type { RemoteIdentifier, StepName, StepView } from './case-model.js';
import { writeCaseStatus } from './case-status.js';
import { UUID } from './read-case.js';

/** A record a completed step left at SATUSEHAT when its case was abandoned (ADR 0007). */
export interface RemoteRecordLeft extends RemoteIdentifier {
  step: StepName;
}

/** Locks case `caseId` for an operator action, returning its status. @throws Problem `NOT_FOUND` when there is no such case. */
async function lockCase(trx: Transaction<Database>, caseId: string) {
  const kase = UUID.test(caseId)
    ? await trx.selectFrom('case').select(['status', 'waiting_for']).where('id', '=', caseId).forUpdate().executeTakeFirst()
    : undefined;
  if (!kase) throw new Problem('NOT_FOUND', []);
  return kase;
}

/**
 * Replays a dead-lettered case from its failed step (#37), in one
 * transaction holding the case row lock, as ingest and the outbox do: the
 * step becomes `ready` again with no current error, and the attempt cap
 * counts from zero, while its attempt numbering, attempt log, the completed
 * steps and the states of the steps after it stay as they are. The replay is
 * recorded with the reason it cleared and the operator's note. The step's
 * next attempt re-resolves every value, KFA details included.
 * @throws Problem `NOT_FOUND`; `CASE_NOT_DEAD_LETTERED` (409) for a case in any other status.
 */
export function replayCase(db: Kysely<Database>, caseId: string, note: string | null, now: Date): Promise<void> {
  return db.transaction().execute(async (trx) => {
    const kase = await lockCase(trx, caseId);
    if (kase.status !== 'dead_lettered') throw new Problem('CASE_NOT_DEAD_LETTERED', []);
    const steps = await trx.selectFrom('step').select(['seq', 'state', 'dead_letter_reason']).where('case_id', '=', caseId).orderBy('seq').execute();
    const failed = steps.find((s) => s.state === 'dead_lettered');
    if (!failed?.dead_letter_reason) throw new Error(`invariant broken: dead-lettered case ${caseId} has no dead-lettered step with a reason`);

    await trx
      .updateTable('step')
      .set((eb) => ({
        state: 'ready',
        dead_letter_reason: null,
        attempts_before_replay: eb.ref('attempts'),
        replayed_at: now,
        available_at: null,
        updated_at: now,
      }))
      .where('case_id', '=', caseId)
      .where('seq', '=', failed.seq)
      .execute();
    await trx.insertInto('replay').values({ case_id: caseId, seq: failed.seq, reason: failed.dead_letter_reason, note, replayed_at: now }).execute();
    const next = steps.map((s): StepView => ({ seq: s.seq, state: s.seq === failed.seq ? 'ready' : s.state }));
    await writeCaseStatus(trx, caseId, next, now);
  });
}

/**
 * Abandons a waiting or dead-lettered case (ADR 0007), in one transaction
 * holding the case row lock: every step not completed becomes `abandoned`,
 * and the case `abandoned`, for good. Nothing is sent to SATUSEHAT. The
 * abandonment records the note, the status the case had, what it waited for
 * or why it was dead-lettered, and the records its completed steps left at
 * SATUSEHAT.
 * @throws Problem `NOT_FOUND`; `CASE_NOT_ABANDONABLE` (409) for a case in any other status.
 */
export function abandonCase(db: Kysely<Database>, caseId: string, note: string, now: Date): Promise<void> {
  return db.transaction().execute(async (trx) => {
    const kase = await lockCase(trx, caseId);
    if (kase.status !== 'waiting' && kase.status !== 'dead_lettered') throw new Problem('CASE_NOT_ABANDONABLE', []);
    const steps = await trx
      .selectFrom('step')
      .select(['seq', 'name', 'state', 'dead_letter_reason', 'remote_type', 'remote_id', 'remote_version'])
      .where('case_id', '=', caseId)
      .orderBy('seq')
      .execute();
    const remoteRecordsLeft = steps.flatMap((s): RemoteRecordLeft[] =>
      s.state === 'completed' && s.remote_type !== null && s.remote_id !== null
        ? // Stored only by lease-fenced completion, from a RemoteIdentifier.
          [{ step: s.name, type: s.remote_type, id: s.remote_id as RemoteIdentifier['id'], version: s.remote_version }]
        : [],
    );

    await trx
      .updateTable('step')
      .set({ state: 'abandoned', updated_at: now })
      .where('case_id', '=', caseId)
      .where('state', '<>', 'completed')
      .execute();
    await trx
      .updateTable('case')
      .set({ status: 'abandoned', waiting_for: null, waiting_since: null, dead_lettered_since: null, updated_at: now })
      .where('id', '=', caseId)
      .execute();
    await trx
      .insertInto('abandonment')
      .values({
        case_id: caseId,
        note,
        abandoned_at: now,
        previous_status: kase.status,
        waiting_for: kase.waiting_for,
        dead_letter_reason: steps.find((s) => s.state === 'dead_lettered')?.dead_letter_reason ?? null,
        remote_records_left: JSON.stringify(remoteRecordsLeft),
      })
      .execute();
  });
}
