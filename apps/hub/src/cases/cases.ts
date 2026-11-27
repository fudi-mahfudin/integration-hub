import type { Kysely } from 'kysely';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { HubMetrics } from '../observability/metrics.js';
import { abandonCase, replayCase } from './operator-actions.js';
import type { CaseScope } from './case-summary.js';
import { summariseDeadLetters, type DeadLetterGroup } from './dead-letter-summary.js';
import { listCases, type CaseFilter, type CasePage, type CasePageRequest } from './list-cases.js';
import { readCase, type CaseView } from './read-case.js';

/** Cases as the HTTP API reads them and operators act on them. */
export interface Cases {
  /** A page of the cases in `scope` matching `filter`, newest first, with `stalled` computed now. */
  list(scope: CaseScope, filter: CaseFilter, page: CasePageRequest): Promise<CasePage>;
  /** The dead-lettered cases in `scope`, grouped by reason. */
  deadLetterSummary(scope: CaseScope): Promise<DeadLetterGroup[]>;
  /** One case in `scope`, with `stalled` computed now; `undefined` when there is none. */
  read(scope: CaseScope, caseId: string): Promise<CaseView | undefined>;
  /** Replays a dead-lettered case from its failed step (see `replayCase`), and answers the case as it is then. */
  replay(caseId: string, note: string | null): Promise<CaseView>;
  /** Abandons a waiting or dead-lettered case (see `abandonCase`), and answers the case as it is then. */
  abandon(caseId: string, note: string): Promise<CaseView>;
}

/** Builds the cases module over the hub database. Only the composition root calls this. */
export function createCases(deps: { db: Kysely<Database>; clock: Clock; stalledAfterMs: number; metrics: Pick<HubMetrics, 'caseAbandoned'> }): Cases {
  const { db, clock, stalledAfterMs, metrics } = deps;
  const read = (scope: CaseScope, caseId: string) => readCase(db, scope, caseId, { now: clock(), stalledAfterMs });
  const readActedOn = async (caseId: string) => {
    const view = await read('operator', caseId);
    if (!view) throw new Error(`case ${caseId} was just acted on, yet does not read back`);
    return view;
  };
  return {
    list: (scope, filter, page) => listCases(db, scope, filter, page, { now: clock(), stalledAfterMs }),
    deadLetterSummary: (scope) => summariseDeadLetters(db, scope),
    read,
    async replay(caseId, note) {
      await replayCase(db, caseId, note, clock());
      return readActedOn(caseId);
    },
    async abandon(caseId, note) {
      metrics.caseAbandoned(await abandonCase(db, caseId, note, clock()));
      return readActedOn(caseId);
    },
  };
}
