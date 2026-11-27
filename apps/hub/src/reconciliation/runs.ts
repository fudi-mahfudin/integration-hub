import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { CaseId, RemoteIdentifier, StepName } from '../cases/case-model.js';
import { COMPLETED_RUN_STATUSES, ENDED_RUN_STATUSES, type DivergenceClass, type ReconciliationRunStatus } from './model.js';

/** How long runs and their findings are kept (#39): older ones are deleted when a new run is created, the latest completed run aside. */
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Who asked for a run. */
export type RunTrigger = 'operator' | 'schedule';

/** The on-demand narrowing of a run's scope (#39); null for no narrowing. */
export interface RunScope {
  /** Only these cases. */
  caseIds: CaseId[] | null;
  /** Only cases whose last change is at or after this instant. */
  since: Date | null;
}

/** The answer to a request for a run: the new run's id, or the id of the run already queued or running. */
export type RunRequested = { created: string } | { running: string };

/**
 * Creates a queued run, unless one is already queued or running (#39); the
 * database's partial unique index decides between concurrent requests. In
 * the same transaction, runs requested more than 14 days before `now` are
 * deleted with their findings, except the latest completed run.
 */
export function requestRun(db: Kysely<Database>, trigger: RunTrigger, scope: RunScope, now: Date): Promise<RunRequested> {
  return db.transaction().execute(async (trx): Promise<RunRequested> => {
    const created = await trx
      .insertInto('reconciliation_runs')
      .values({ status: 'queued', trigger, case_ids: scope.caseIds, since: scope.since, requested_at: now })
      .onConflict((oc) => oc.expression(sql`(true)`).where(sql.ref('status'), 'in', sql`('queued', 'running')`).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!created) {
      const open = await trx.selectFrom('reconciliation_runs').select('id').where('status', 'in', ['queued', 'running']).executeTakeFirst();
      // The open run ended between the insert and this read: ask again.
      if (!open) throw new Error('a reconciliation run was open when one was requested, and ended before it could be named; request it again');
      return { running: open.id };
    }
    const latestCompleted = trx
      .selectFrom('reconciliation_runs')
      .select('id')
      .where('status', 'in', COMPLETED_RUN_STATUSES)
      .orderBy('ended_at', 'desc')
      .limit(1);
    await trx
      .deleteFrom('reconciliation_runs')
      .where('requested_at', '<', new Date(now.getTime() - RETENTION_MS))
      .where('status', 'in', ENDED_RUN_STATUSES)
      // `not in` an empty set holds: with no completed run, every old one goes.
      .where('id', 'not in', latestCompleted)
      .execute();
    return { created: created.id };
  });
}

/** How many cases a run checked, by how each check ended. */
export interface RunCounts {
  cases: number;
  clean: number;
  divergent: number;
  skipped: number;
  unchecked: number;
}

/** A run as `GET /v1/admin/reconciliation/runs` lists it. */
export interface RunSummary {
  runId: string;
  status: ReconciliationRunStatus;
  trigger: RunTrigger;
  scope: { caseIds: string[] | null; since: string | null };
  /** ISO 8601 UTC. */
  requestedAt: string;
  /** ISO 8601 UTC; null until a worker starts it. */
  startedAt: string | null;
  /** ISO 8601 UTC; null until it ends. */
  endedAt: string | null;
  /** Why a `failed` run failed; null otherwise. */
  error: string | null;
  counts: RunCounts;
}

/** What a run found on one case, as the run view shows it. */
export interface FindingView {
  caseId: CaseId;
  source: string;
  visitId: string;
  /** A divergence; or the case changed during its check (`skipped`); or a search failed (`unchecked`). */
  kind: 'divergence' | 'skipped' | 'unchecked';
  class: DivergenceClass | null;
  step: StepName | null;
  resourceType: RemoteIdentifier['type'] | null;
  field: string | null;
  /** What was expected and found; for a person's IHS number only `{ differs: true }`. For `unchecked`, the error. */
  snapshot: unknown;
}

/** A run as `GET /v1/admin/reconciliation/runs/{id}` shows it: its summary and one page of its findings. */
export interface RunView extends RunSummary {
  findings: FindingView[];
  /** The cursor of the next page of findings; null on the last. */
  nextCursor: string | null;
}

/** A page of a run's findings. */
export interface FindingPageRequest {
  limit: number;
  /** A `nextCursor` the hub gave; null for the first page. */
  cursor: string | null;
}

/** Whether `cursor` is one a run view gave. */
export const isFindingCursor = (cursor: string) => /^\d{1,19}$/.test(cursor);

function selectRuns(db: Kysely<Database>) {
  return db
    .selectFrom('reconciliation_runs as r')
    .selectAll('r')
    .select((eb) => [
      eb.selectFrom('reconciliation_checks as k').whereRef('k.run_id', '=', 'r.id').select(sql<string>`count(*)`.as('n')).as('cases'),
      ...(['clean', 'divergent', 'skipped', 'unchecked'] as const).map((outcome) =>
        eb
          .selectFrom('reconciliation_checks as k')
          .whereRef('k.run_id', '=', 'r.id')
          .where('k.outcome', '=', outcome)
          .select(sql<string>`count(*)`.as('n'))
          .as(outcome),
      ),
    ]);
}

type RunRow = Awaited<ReturnType<ReturnType<typeof selectRuns>['executeTakeFirstOrThrow']>>;

function toSummary(row: RunRow): RunSummary {
  const count = (n: string | null) => Number(n ?? 0);
  return {
    runId: row.id,
    status: row.status,
    trigger: row.trigger,
    scope: { caseIds: row.case_ids, since: row.since?.toISOString() ?? null },
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    error: row.error,
    counts: { cases: count(row.cases), clean: count(row.clean), divergent: count(row.divergent), skipped: count(row.skipped), unchecked: count(row.unchecked) },
  };
}

/** The latest `limit` runs, newest first. */
export async function listRuns(db: Kysely<Database>, limit: number): Promise<RunSummary[]> {
  const rows = await selectRuns(db).orderBy('r.requested_at', 'desc').limit(limit).execute();
  return rows.map(toSummary);
}

/** One run with a page of its findings, in the order it found them; `undefined` when there is no such run. `runId` must be a uuid. */
export async function readRun(db: Kysely<Database>, runId: string, page: FindingPageRequest): Promise<RunView | undefined> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const row = await selectRuns(trx).where('r.id', '=', runId).executeTakeFirst();
      if (!row) return undefined;
      let query = trx
        .selectFrom('reconciliation_findings as f')
        .innerJoin('case as c', 'c.id', 'f.case_id')
        .select(['f.id', 'f.case_id', 'c.source_system_id', 'c.visit_id', 'f.kind', 'f.class', 'f.step', 'f.resource_type', 'f.field', 'f.snapshot'])
        .where('f.run_id', '=', runId)
        .orderBy('f.id')
        .limit(page.limit + 1);
      if (page.cursor !== null) query = query.where('f.id', '>', page.cursor);
      const found = await query.execute();
      const shown = found.slice(0, page.limit);
      return {
        ...toSummary(row),
        findings: shown.map((f) => ({
          // A foreign key to the case table: a case id.
          caseId: f.case_id as CaseId,
          source: f.source_system_id,
          visitId: f.visit_id,
          kind: f.kind,
          class: f.class,
          step: f.step,
          resourceType: f.resource_type,
          field: f.field,
          // Written by the reconciler as JSON; shown as stored.
          snapshot: f.snapshot,
        })),
        nextCursor: found.length > page.limit ? (shown.at(-1)?.id ?? null) : null,
      };
    });
}

/** A divergence as the case view shows it: from the latest completed run that covered the case. */
export interface DivergenceView {
  runId: string;
  /** When the run checked the case, ISO 8601 UTC. */
  checkedAt: string;
  class: DivergenceClass;
  step: StepName;
  resourceType: RemoteIdentifier['type'];
  field: string | null;
  snapshot: unknown;
}

/**
 * The divergences the latest completed run that covered case `caseId` found
 * on it (#39): a run covered a case when it checked it to the end, so a
 * `skipped` or `unchecked` check doesn't count. Empty when no run has.
 * `db` may be a transaction, so the case view reads them from its snapshot.
 */
export async function readCaseDivergences(db: Kysely<Database>, caseId: CaseId): Promise<DivergenceView[]> {
  const check = await db
    .selectFrom('reconciliation_checks as k')
    .innerJoin('reconciliation_runs as r', 'r.id', 'k.run_id')
    .select(['k.run_id', 'k.checked_at'])
    .where('k.case_id', '=', caseId)
    .where('k.outcome', 'in', ['clean', 'divergent'])
    .where('r.status', 'in', COMPLETED_RUN_STATUSES)
    .orderBy('r.ended_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!check) return [];
  const found = await db
    .selectFrom('reconciliation_findings')
    .select(['class', 'step', 'resource_type', 'field', 'snapshot'])
    .where('run_id', '=', check.run_id)
    .where('case_id', '=', caseId)
    .where('kind', '=', 'divergence')
    .orderBy('id')
    .execute();
  return found.flatMap((f) =>
    f.class !== null && f.step !== null && f.resource_type !== null
      ? [{ runId: check.run_id, checkedAt: check.checked_at.toISOString(), class: f.class, step: f.step, resourceType: f.resource_type, field: f.field, snapshot: f.snapshot }]
      : [],
  );
}

/** How often a long-poll reads the run again while it waits for it to end. */
const LONG_POLL_INTERVAL_MS = 100;

/** Reconciliation runs as the operator's API requests and reads them (#39). */
export interface ReconciliationRuns {
  /** Requests a run over the default scope, narrowed by `scope` (see `requestRun`). */
  request(scope: RunScope): Promise<RunRequested>;
  /**
   * One run (`runId` a uuid) with a page of its findings; until it ends, waits up to `waitMs`
   * for it to (a long-poll). `undefined` when there is no such run.
   */
  read(runId: string, page: FindingPageRequest, waitMs: number): Promise<RunView | undefined>;
  /** The latest `limit` runs, newest first. */
  list(limit: number): Promise<RunSummary[]>;
}

/** Builds the operator's view of reconciliation runs over the hub database. Only the composition root calls this. */
export function createReconciliationRuns(deps: { db: Kysely<Database>; clock: Clock }): ReconciliationRuns {
  const { db, clock } = deps;
  // Widened so `includes` takes any status; it only reads the list.
  const ended = (run: RunView) => (ENDED_RUN_STATUSES as readonly string[]).includes(run.status);
  return {
    request: (scope) => requestRun(db, 'operator', scope, clock()),
    async read(runId, page, waitMs) {
      // A wall-clock deadline: it bounds how long the request is held, and changes nothing.
      const deadline = Date.now() + waitMs;
      for (;;) {
        const run = await readRun(db, runId, page);
        if (!run || ended(run) || Date.now() >= deadline) return run;
        await new Promise((resolve) => setTimeout(resolve, Math.min(LONG_POLL_INTERVAL_MS, deadline - Date.now())));
      }
    },
    list: (limit) => listRuns(db, limit),
  };
}
