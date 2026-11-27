import { sql, type Kysely } from 'kysely';
import { CASE_STATUSES, STEPS, type CaseStatus, type StepName } from '../cases/case-model.js';
import { waitingStalledBefore } from '../cases/case-summary.js';
import type { Database } from '../db/database.js';
import { COMPLETED_RUN_STATUSES, DIVERGENCE_CLASSES, type DivergenceClass } from '../reconciliation/model.js';
import type { DatabaseGauges, OutboxGauges } from './metrics.js';

const secondsBetween = (earlier: Date, later: Date) => Math.max(0, (later.getTime() - earlier.getTime()) / 1000);

/**
 * Reads the hub service's database-derived gauges (#15) as of `now`: cases
 * by status, stalled cases, the oldest dead-letter's age, per step the
 * claimable steps and the oldest one's lag, and the latest completed
 * reconciliation run's divergences. A step is claimable from its `updated_at`
 * when `ready`, from its `available_at` when in `retry_wait`.
 */
export async function readDatabaseGauges(db: Kysely<Database>, stall: { now: Date; stalledAfterMs: number }): Promise<DatabaseGauges> {
  const { now } = stall;
  const [byStatus, caseFacts, outbox, latestRun] = await Promise.all([
    db.selectFrom('case').select(['status', (eb) => eb.fn.countAll<string>().as('n')]).groupBy('status').execute(),
    db
      .selectFrom('case')
      .select([
        sql<string>`count(*) filter (where status = 'waiting' and waiting_since < ${waitingStalledBefore(stall)})`.as('stalled'),
        sql<Date | null>`min(dead_lettered_since) filter (where status = 'dead_lettered')`.as('oldest_dead_lettered'),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('step')
      .select([
        'name',
        (eb) => eb.fn.countAll<string>().as('n'),
        sql<Date>`min(case when state = 'ready' then updated_at else available_at end)`.as('oldest'),
      ])
      .where((eb) => eb.or([eb('state', '=', 'ready'), eb.and([eb('state', '=', 'retry_wait'), eb('available_at', '<=', now)])]))
      .groupBy('name')
      .execute(),
    db
      .selectFrom('reconciliation_runs')
      .select(['id', 'ended_at'])
      .where('status', 'in', COMPLETED_RUN_STATUSES)
      .orderBy('ended_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);

  // Each built with a key for every member of the closed set it is typed by.
  const cases = Object.fromEntries(CASE_STATUSES.map((s) => [s, 0])) as Record<CaseStatus, number>;
  for (const row of byStatus) cases[row.status] = Number(row.n);

  // As above: a key for every step name.
  const outboxGauges = Object.fromEntries(STEPS.map((s) => [s.name, { claimable: 0, lagSeconds: 0 }])) as Record<StepName, OutboxGauges>;
  for (const row of outbox) outboxGauges[row.name] = { claimable: Number(row.n), lagSeconds: secondsBetween(row.oldest, now) };

  // As above: a key for every divergence class.
  const divergences = Object.fromEntries(DIVERGENCE_CLASSES.map((c) => [c, 0])) as Record<DivergenceClass, number>;
  if (latestRun) {
    const found = await db
      .selectFrom('reconciliation_findings')
      .select(['class', (eb) => eb.fn.countAll<string>().as('n')])
      .where('run_id', '=', latestRun.id)
      .where('kind', '=', 'divergence')
      .groupBy('class')
      .execute();
    for (const row of found) if (row.class !== null) divergences[row.class] = Number(row.n);
  }

  return {
    cases,
    casesStalled: Number(caseFacts.stalled),
    deadLetteredOldestAgeSeconds: caseFacts.oldest_dead_lettered === null ? 0 : secondsBetween(caseFacts.oldest_dead_lettered, now),
    outbox: outboxGauges,
    divergences,
    reconciliationLastCompletedSeconds: latestRun?.ended_at ? latestRun.ended_at.getTime() / 1000 : null,
  };
}
