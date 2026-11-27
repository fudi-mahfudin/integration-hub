import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { DeadLetterReason } from './case-model.js';
import type { CaseScope } from './case-summary.js';
import { reasonClassOf, type ReasonClass } from './reason-class.js';

/** The dead-lettered cases of one reason, as `GET /v1/dead-letters/summary` shows them (#38). */
export interface DeadLetterGroup {
  reason: DeadLetterReason;
  class: ReasonClass;
  /** How many cases are dead-lettered for `reason` now. */
  count: number;
  /** Since when the longest-dead-lettered of them has been dead-lettered, ISO 8601 UTC. */
  oldestSince: string;
}

/**
 * The dead-lettered cases in `scope`, grouped by reason: `replayable` groups
 * first, then `source_data`, each by reason. A reason with no dead-lettered
 * case has no group.
 */
export async function summariseDeadLetters(db: Kysely<Database>, scope: CaseScope): Promise<DeadLetterGroup[]> {
  let query = db
    .selectFrom('case as c')
    .innerJoin('step as s', (join) => join.onRef('s.case_id', '=', 'c.id').on('s.state', '=', 'dead_lettered'))
    .where('c.status', '=', 'dead_lettered')
    .where('s.dead_letter_reason', 'is not', null)
    .select((eb) => ['s.dead_letter_reason', eb.fn.countAll<string>().as('count'), eb.fn.min('c.dead_lettered_since').as('oldest_since')])
    .groupBy('s.dead_letter_reason');
  if (scope !== 'operator') query = query.where('c.source_system_id', '=', scope.sourceSystemId);
  const rows = await query.execute();
  const order: Record<ReasonClass, number> = { replayable: 0, source_data: 1 };
  return rows
    .flatMap((r): DeadLetterGroup[] => {
      if (r.dead_letter_reason === null) return [];
      if (r.oldest_since === null) throw new Error(`dead-lettered cases of reason ${r.dead_letter_reason} have no dead_lettered_since`);
      return [{ reason: r.dead_letter_reason, class: reasonClassOf(r.dead_letter_reason), count: Number(r.count), oldestSince: r.oldest_since.toISOString() }];
    })
    .sort((a, b) => order[a.class] - order[b.class] || a.reason.localeCompare(b.reason));
}
