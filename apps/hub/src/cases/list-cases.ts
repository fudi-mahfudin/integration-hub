import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { CaseStatus, DeadLetterReason, StepName } from './case-model.js';
import { selectCaseSummaries, toCaseSummary, waitingStalledBefore, type CaseScope, type CaseSummary, type StallRule } from './case-summary.js';

/** One page of the case list. */
export interface CasePage {
  cases: CaseSummary[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/**
 * Where a page of the case list starts: after the case with this `list_seq`.
 * The list orders by `list_seq`, which a case gets once at insert, so a
 * cursor keeps its place however cases change while a client pages.
 */
export type CaseCursor = { afterListSeq: string };

/** Which cases the list shows: those matching every filter that is not null. */
export interface CaseFilter {
  status: CaseStatus | null;
  /** `stalled` as of the read: true for stalled cases only, false for every other case. */
  stalled: boolean | null;
  /** The case's current step; a completed case has none. */
  step: StepName | null;
  /** A source system's id; an unregistered one matches no case. */
  source: string | null;
  visitId: string | null;
  /** The dead-letter reason of a dead-lettered case. */
  reason: DeadLetterReason | null;
}

/** Which page of the case list to read. */
export interface CasePageRequest {
  /** 1-500. */
  limit: number;
  /** null for the first page. */
  cursor: CaseCursor | null;
}

/** The opaque text of a cursor, as `nextCursor` gives it. */
export function encodeCaseCursor(cursor: CaseCursor): string {
  return Buffer.from(`c1:${cursor.afterListSeq}`).toString('base64url');
}

/** The cursor `text` encodes, or `undefined` when the hub never gave it. */
export function decodeCaseCursor(text: string): CaseCursor | undefined {
  const match = /^c1:([1-9]\d{0,17})$/.exec(Buffer.from(text, 'base64url').toString('utf8'));
  return match?.[1] === undefined ? undefined : { afterListSeq: match[1] };
}

/** Lists the cases in `scope` that match `filter`, newest first, a page at a time. */
export async function listCases(
  db: Kysely<Database>,
  scope: CaseScope,
  filter: CaseFilter,
  page: CasePageRequest,
  stall: StallRule,
): Promise<CasePage> {
  let query = selectCaseSummaries(db, scope);
  if (filter.status !== null) query = query.where('c.status', '=', filter.status);
  if (filter.step !== null) query = query.where('current.name', '=', filter.step);
  if (filter.source !== null) query = query.where('c.source_system_id', '=', filter.source);
  if (filter.visitId !== null) query = query.where('c.visit_id', '=', filter.visitId);
  if (filter.reason !== null) query = query.where('c.status', '=', 'dead_lettered').where('failed.dead_letter_reason', '=', filter.reason);
  if (filter.stalled !== null) {
    const stalledBefore = waitingStalledBefore(stall);
    query = filter.stalled
      ? query.where('c.status', '=', 'waiting').where('c.waiting_since', '<', stalledBefore)
      : query.where((eb) => eb.or([eb('c.status', '<>', 'waiting'), eb('c.waiting_since', 'is', null), eb('c.waiting_since', '>=', stalledBefore)]));
  }
  if (page.cursor) query = query.where('c.list_seq', '<', page.cursor.afterListSeq);
  // One more than the page holds, to learn whether another page follows.
  const rows = await query.orderBy('c.list_seq', 'desc').limit(page.limit + 1).execute();
  const shown = rows.slice(0, page.limit);
  const last = shown.at(-1);
  return {
    cases: shown.map((r) => toCaseSummary(r, stall)),
    nextCursor: rows.length > page.limit && last ? encodeCaseCursor({ afterListSeq: last.list_seq }) : null,
  };
}
