import type { Kysely } from 'kysely';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { abandonCase, replayCase } from './operator-actions.js';
import { readCase, type CaseScope, type CaseView } from './read-case.js';

/** Cases as the HTTP API reads them and operators act on them. */
export interface Cases {
  /** One case in `scope`, with `stalled` computed now; `undefined` when there is none. */
  read(scope: CaseScope, caseId: string): Promise<CaseView | undefined>;
  /** Replays a dead-lettered case from its failed step (see `replayCase`), and answers the case as it is then. */
  replay(caseId: string, note: string | null): Promise<CaseView>;
  /** Abandons a waiting or dead-lettered case (see `abandonCase`), and answers the case as it is then. */
  abandon(caseId: string, note: string): Promise<CaseView>;
}

/** Builds the cases module over the hub database. Only the composition root calls this. */
export function createCases(deps: { db: Kysely<Database>; clock: Clock; stalledAfterMs: number }): Cases {
  const { db, clock, stalledAfterMs } = deps;
  const read = (scope: CaseScope, caseId: string) => readCase(db, scope, caseId, { now: clock(), stalledAfterMs });
  const readActedOn = async (caseId: string) => {
    const view = await read('operator', caseId);
    if (!view) throw new Error(`case ${caseId} was just acted on, yet does not read back`);
    return view;
  };
  return {
    read,
    async replay(caseId, note) {
      await replayCase(db, caseId, note, clock());
      return readActedOn(caseId);
    },
    async abandon(caseId, note) {
      await abandonCase(db, caseId, note, clock());
      return readActedOn(caseId);
    },
  };
}
