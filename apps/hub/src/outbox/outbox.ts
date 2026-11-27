import { sql, type Kysely, type Transaction } from 'kysely';
import type { OrganizationId, SourceSystemId } from '../auth/source-systems.js';
import type { Brand } from '../brand.js';
import {
  applyCompletion,
  type CaseId,
  type DeadLetterReason,
  type RemoteIdentifier,
  type StepName,
  type StepView,
  type VisitId,
} from '../cases/case-model.js';
import { readSteps, writeCaseStatus } from '../cases/case-status.js';
import type { Clock } from '../clock.js';
import type { AttemptOutcome, Database } from '../db/database.js';
import type { WorkerMetrics } from '../observability/metrics.js';
import type { Traceparent } from '../observability/tracing.js';
import type { AttemptFacts, FinalOutcome } from '../steps/step-outcome.js';
import type { ReadRetry } from '../satusehat/transport.js';
import { nextAttemptAt, type RetryPolicy } from './retry-policy.js';

/** The token of one claim on a step. An outcome is applied only while it still matches (#8). */
export type LeaseToken = Brand<string, 'LeaseToken'>;

/** A step a worker holds under a lease. */
export interface ClaimedStep {
  caseId: CaseId;
  seq: number;
  name: StepName;
  /** This claim's attempt number: the counter increments on claim (#8). */
  attempt: number;
  /** This attempt's number toward the attempt cap: attempts since the step's last replay (#37). */
  capAttempt: number;
  /** When the step was last replayed; KFA details fetched before then are fetched again (#10). Null if never. */
  replayedAt: Date | null;
  /** When the claim was taken: the attempt's start. */
  startedAt: Date;
  leaseToken: LeaseToken;
  sourceSystemId: SourceSystemId;
  /** The case's organization, from its source system's registration (#10). */
  organizationId: OrganizationId;
  visitId: VisitId;
  /** The traceparent of the ingest span that accepted the step's event (#42): the attempt joins its trace. Null when it was not traced. */
  traceparent: Traceparent | null;
}

/** An attempt that ended transiently: how, what it saw, and the answer's `Retry-After`, if any. */
export interface TransientEnd {
  /** How the attempt ended, for its row in the attempt log. */
  outcome: 'failed' | 'attempt_budget_exceeded';
  /** What it used and saw. */
  facts: AttemptFacts;
  /** Its read retries. */
  readRetries: readonly ReadRetry[];
  /** The instant the `Retry-After` of the answer that ended the attempt named; null when there was none. */
  retryAfter: Date | null;
  /** A stale remote identifier of an earlier step, replaced by the one a search found (#10); null when none. */
  refreshed: { step: StepName; remote: RemoteIdentifier } | null;
}

/** What storing a transient end did: the step waits to be retried, its retries are exhausted, or the claim had lost its lease. */
export type TransientStored = 'retry_wait' | 'exhausted' | 'lease_lost';

/**
 * The Postgres outbox (ADR 0002). A step row is its own outbox entry: the
 * transaction that makes a step eligible sets it `ready`, and workers take it
 * from here under a lease. Every attempt it logs, step it completes and step
 * it dead-letters is counted in the worker's metrics once its transaction
 * commits (#41), so the metrics agree with the attempt log.
 */
export interface Outbox {
  /**
   * Claims the longest-waiting claimable step (`ready`, `retry_wait` whose
   * `available_at` has come, or `in_flight` with an expired lease), skipping
   * rows other workers are claiming, under a new lease; `undefined` when
   * there is none. Taking over an expired lease logs the expired attempt as
   * `lease_expired`; when that was the last attempt allowed, the step is
   * dead-lettered `RETRIES_EXHAUSTED` instead of claimed (#8). The cap
   * counts only attempts since the step's last replay (#37).
   */
  claim(): Promise<ClaimedStep | undefined>;
  /**
   * Stores an attempt's outcome, fenced by its lease (#8), in one transaction
   * with its row in the attempt log, read retries included. Completion: the step becomes `completed`
   * with its remote identifier and pins, and the next step `ready` if its
   * event is stored, else the case waits for it. Dead-lettering: the step and
   * its case become `dead_lettered` with the reason; the rest of the case is
   * held. Resolves to `false` when the claim no longer holds the lease: the
   * step is unchanged and nothing is logged, since only a claim that took the
   * step over changes its token, and that claim logged this attempt as
   * `lease_expired`.
   */
  storeOutcome(step: ClaimedStep, outcome: FinalOutcome, readRetries: readonly ReadRetry[]): Promise<boolean>;
  /**
   * Stores an attempt that ended transiently, fenced by its lease, with its
   * row in the attempt log: the step waits in `retry_wait` until the retry
   * policy's next attempt time, or, if this was the last attempt allowed, it
   * and its case are dead-lettered `RETRIES_EXHAUSTED`. A claim that lost its
   * lease changes and logs nothing, as for `storeOutcome`.
   */
  storeTransient(step: ClaimedStep, end: TransientEnd): Promise<TransientStored>;
}

/** Builds the outbox over the hub database. Only the composition root calls this. */
export function createOutbox(deps: {
  db: Kysely<Database>;
  clock: Clock;
  leaseMs: number;
  retry: RetryPolicy;
  /** Draws from [0, 1), for the backoff's jitter. */
  random: () => number;
  metrics: Pick<WorkerMetrics, 'stepAttempt' | 'stepCompleted' | 'stepDeadLettered'>;
}): Outbox {
  const { db, clock, leaseMs, retry, random, metrics } = deps;
  const secondsSince = (startedAt: Date) => (clock().getTime() - startedAt.getTime()) / 1000;

  /** The insert of the attempt's row in the attempt log; the caller executes it. */
  const attemptRow = (
    // A transaction is a Kysely too: the row commits with whatever the caller's transaction changed.
    trx: Kysely<Database>,
    step: ClaimedStep,
    endedAt: Date,
    row: { outcome: AttemptOutcome; errorCode: DeadLetterReason | null; facts: AttemptFacts; readRetries: readonly ReadRetry[] },
  ) =>
    trx
      .insertInto('attempt')
      .values({
        case_id: step.caseId,
        seq: step.seq,
        attempt: step.attempt,
        started_at: step.startedAt,
        ended_at: endedAt,
        outcome: row.outcome,
        error_code: row.errorCode,
        http_status: row.facts.httpStatus,
        values_used: JSON.stringify(row.facts.valuesUsed),
        lookup_methods: JSON.stringify(row.facts.lookupMethods),
        violations: JSON.stringify(row.facts.violations),
        read_retries: JSON.stringify(row.readRetries),
      });

  /** The fence: this step, still in flight, still under this claim's token. */
  const holding = (trx: Transaction<Database>, step: ClaimedStep) =>
    trx
      .updateTable('step')
      .where('case_id', '=', step.caseId)
      .where('seq', '=', step.seq)
      .where('state', '=', 'in_flight')
      .where('lease_token', '=', step.leaseToken);

  /** Ends a claim's hold on its step. */
  const released = { lease_token: null, lease_expires_at: null, claimed_at: null };

  /**
   * Writes the steps of `next` that differ from `before`, other than `seq`
   * (which the caller changed through the fence), and the case status.
   */
  async function writeRest(trx: Transaction<Database>, caseId: CaseId, seq: number, before: readonly StepView[], next: readonly StepView[], now: Date) {
    for (const s of next) {
      if (s.seq === seq || before.find((b) => b.seq === s.seq)?.state === s.state) continue;
      await trx.updateTable('step').set({ state: s.state, updated_at: now }).where('case_id', '=', caseId).where('seq', '=', s.seq).execute();
    }
    await writeCaseStatus(trx, caseId, next, now);
  }

  const withState = (steps: readonly StepView[], seq: number, state: StepView['state']) =>
    steps.map((s): StepView => (s.seq === seq ? { seq, state } : s));

  /**
   * One claim try in one transaction: `undefined` when nothing is claimable,
   * `'again'` when the row picked was dead-lettered (or its case was busy) instead.
   */
  const claimOnce = async (): Promise<ClaimedStep | 'again' | undefined> => {
    // What the transaction counts in the metrics, once it has committed.
    const committed: (() => void)[] = [];
    const claimed = await db.transaction().execute(async (trx): Promise<ClaimedStep | 'again' | undefined> => {
      const now = clock();
      // Pick the oldest claimable row and lock it, skipping rows another worker has locked.
      const { rows: picked } = await sql<{ case_id: string; seq: number; name: StepName; state: string; attempts: number; attempts_before_replay: number }>`
        select case_id, seq, name, state, attempts, attempts_before_replay
          from step
         where state = 'ready'
            or (state = 'retry_wait' and available_at <= ${now})
            or (state = 'in_flight' and lease_expires_at <= ${now})
         order by updated_at
         limit 1
           for update skip locked
      `.execute(trx);
      const [row] = picked;
      if (!row) return undefined;
      // Read back from the row the select just locked.
      const caseId = row.case_id as CaseId;

      if (row.state === 'in_flight') {
        // Taking an expired lease over logs its attempt as `lease_expired` (#8), ended when the
        // lease ran out, unless that attempt already logged its own ending.
        const { rows: expired } = await sql<{ started_at: Date; ended_at: Date }>`
          insert into attempt (case_id, seq, attempt, started_at, ended_at, outcome, values_used, lookup_methods, violations, read_retries)
          select case_id, seq, attempts, claimed_at, lease_expires_at, 'lease_expired', '{}', '{}', '[]', '[]'
            from step where case_id = ${caseId} and seq = ${row.seq}
          on conflict (case_id, seq, attempt) do nothing
          returning started_at, ended_at
        `.execute(trx);
        // Counted by the claim that logs it: the worker that lost the lease counts nothing for it.
        for (const a of expired) committed.push(() => metrics.stepAttempt(row.name, 'lease_expired', (a.ended_at.getTime() - a.started_at.getTime()) / 1000));
        // The cap counts the attempts since the step's last replay (#37).
        if (row.attempts - row.attempts_before_replay >= retry.maxAttempts) {
          // Lock the case as storeOutcome does; a case another transaction holds is left for the next try.
          const kase = await trx.selectFrom('case').select('id').where('id', '=', caseId).forUpdate().skipLocked().executeTakeFirst();
          if (!kase) return 'again';
          const before = await readSteps(trx, caseId);
          await trx
            .updateTable('step')
            .set({ state: 'dead_lettered', dead_letter_reason: 'RETRIES_EXHAUSTED', ...released, updated_at: now })
            .where('case_id', '=', caseId)
            .where('seq', '=', row.seq)
            .execute();
          await writeRest(trx, caseId, row.seq, before, withState(before, row.seq, 'dead_lettered'), now);
          committed.push(() => metrics.stepDeadLettered(row.name, 'RETRIES_EXHAUSTED'));
          return 'again';
        }
      }

      // The row type brands what the columns hold: ids Postgres generated or
      // ingest stored from a validated event, and the token gen_random_uuid() just issued.
      const { rows } = await sql<Omit<ClaimedStep, 'startedAt'>>`
        update step s
           set state = 'in_flight',
               attempts = s.attempts + 1,
               lease_token = gen_random_uuid(),
               lease_expires_at = ${new Date(now.getTime() + leaseMs)},
               claimed_at = ${now},
               available_at = null,
               updated_at = ${now}
          from "case" c
         where s.case_id = ${caseId}
           and s.seq = ${row.seq}
           and c.id = s.case_id
        returning s.case_id as "caseId", s.seq, s.name, s.attempts as attempt, s.attempts - s.attempts_before_replay as "capAttempt",
                  s.replayed_at as "replayedAt", s.lease_token as "leaseToken",
                  c.source_system_id as "sourceSystemId", c.organization_id as "organizationId", c.visit_id as "visitId",
                  (select e.traceparent from source_event e where e.case_id = s.case_id and e.type = s.event_type) as traceparent
      `.execute(trx);
      const [taken] = rows;
      if (!taken) throw new Error(`invariant broken: step ${caseId}/${row.seq}, locked for the claim, was not updated`);
      return { ...taken, startedAt: now };
    });
    for (const count of committed) count();
    return claimed;
  };

  return {
    async claim() {
      // Rows dead-lettered on the way are skipped; a few tries bound the loop when a case stays busy.
      for (let tries = 0; tries < 10; tries++) {
        const claimed = await claimOnce();
        if (claimed !== 'again') return claimed;
      }
      return undefined;
    },

    async storeOutcome(step, outcome, readRetries) {
      // Lock the case row (as ingest does, so an arriving event and an outcome
      // apply one at a time), change the step only if the claim still holds
      // its lease, store the re-derived case status, and log the attempt.
      const stored = await db.transaction().execute(async (trx) => {
        const now = clock();
        await trx.selectFrom('case').select('id').where('id', '=', step.caseId).forUpdate().executeTakeFirstOrThrow();
        const before = await readSteps(trx, step.caseId);
        const { change, next, outcome: logged, errorCode } =
          'completed' in outcome
            ? {
                change: {
                  state: 'completed' as const,
                  remote_type: outcome.completed.type,
                  remote_id: outcome.completed.id,
                  remote_version: outcome.completed.version,
                  pins: JSON.stringify(outcome.pins),
                },
                next: () => applyCompletion(before, step.seq),
                outcome: 'completed' as const,
                errorCode: null,
              }
            : {
                change: { state: 'dead_lettered' as const, dead_letter_reason: outcome.deadLettered },
                next: () => withState(before, step.seq, 'dead_lettered'),
                outcome: 'dead_lettered' as const,
                errorCode: outcome.deadLettered,
              };
        const updated = await holding(trx, step).set(change).set({ ...released, updated_at: now }).executeTakeFirst();
        if (updated.numUpdatedRows === 0n) return false;
        await writeRest(trx, step.caseId, step.seq, before, next(), now);
        await attemptRow(trx, step, now, { outcome: logged, errorCode, facts: outcome.attempt, readRetries }).execute();
        return true;
      });
      if (!stored) return false;
      if ('completed' in outcome) {
        metrics.stepAttempt(step.name, 'success', secondsSince(step.startedAt));
        metrics.stepCompleted(step.name);
      } else {
        metrics.stepAttempt(step.name, 'permanent', secondsSince(step.startedAt));
        metrics.stepDeadLettered(step.name, outcome.deadLettered);
      }
      return true;
    },

    async storeTransient(step, end) {
      const stored = await db.transaction().execute(async (trx): Promise<TransientStored> => {
        const now = clock();
        await trx.selectFrom('case').select('id').where('id', '=', step.caseId).forUpdate().executeTakeFirstOrThrow();
        const before = await readSteps(trx, step.caseId);
        const retryAt = nextAttemptAt(retry, { attempt: step.capAttempt, endedAt: now, retryAfter: end.retryAfter }, random);
        const exhausted = retryAt === 'exhausted';
        const updated = await holding(trx, step)
          .set(
            exhausted
              ? { state: 'dead_lettered', dead_letter_reason: 'RETRIES_EXHAUSTED' }
              : { state: 'retry_wait', available_at: retryAt },
          )
          .set({ ...released, updated_at: now })
          .executeTakeFirst();
        if (updated.numUpdatedRows === 0n) return 'lease_lost';
        if (end.refreshed) {
          const { step: name, remote } = end.refreshed;
          await trx
            .updateTable('step')
            .set({ remote_type: remote.type, remote_id: remote.id, remote_version: remote.version, updated_at: now })
            .where('case_id', '=', step.caseId)
            .where('name', '=', name)
            .where('state', '=', 'completed')
            .execute();
        }
        await writeRest(trx, step.caseId, step.seq, before, withState(before, step.seq, exhausted ? 'dead_lettered' : 'retry_wait'), now);
        await attemptRow(trx, step, now, { outcome: end.outcome, errorCode: exhausted ? 'RETRIES_EXHAUSTED' : null, facts: end.facts, readRetries: end.readRetries }).execute();
        return exhausted ? 'exhausted' : 'retry_wait';
      });
      if (stored === 'lease_lost') return stored;
      metrics.stepAttempt(step.name, 'transient', secondsSince(step.startedAt));
      if (stored === 'exhausted') metrics.stepDeadLettered(step.name, 'RETRIES_EXHAUSTED');
      return stored;
    },
  };
}
