import { sql, type Kysely, type Transaction } from 'kysely';
import type { OrganizationId, SourceSystemId } from '../auth/source-systems.js';
import type { Brand } from '../brand.js';
import {
  applyCompletion,
  type CaseId,
  type DeadLetterReason,
  type StepName,
  type StepView,
  type VisitId,
} from '../cases/case-model.js';
import { readSteps, writeCaseStatus } from '../cases/case-status.js';
import type { Clock } from '../clock.js';
import type { AttemptOutcome, Database } from '../db/database.js';
import type { AttemptFacts, StepOutcome } from '../steps/step-outcome.js';

/** The token of one claim on a step. An outcome is applied only while it still matches (#8). */
export type LeaseToken = Brand<string, 'LeaseToken'>;

/** A step a worker holds under a lease. */
export interface ClaimedStep {
  caseId: CaseId;
  seq: number;
  name: StepName;
  /** This claim's attempt number: the counter increments on claim (#8). */
  attempt: number;
  /** When the claim was taken: the attempt's start. */
  startedAt: Date;
  leaseToken: LeaseToken;
  sourceSystemId: SourceSystemId;
  /** The case's organization, from its source system's registration (#10). */
  organizationId: OrganizationId;
  visitId: VisitId;
}

/**
 * The Postgres outbox (ADR 0002). A step row is its own outbox entry: the
 * transaction that makes a step eligible sets it `ready`, and workers take it
 * from here under a lease.
 */
export interface Outbox {
  /**
   * Claims the longest-waiting claimable step (`ready`, or `in_flight` with
   * an expired lease), skipping rows other workers are claiming, under a new
   * lease; `undefined` when there is none.
   */
  claim(): Promise<ClaimedStep | undefined>;
  /**
   * Stores an attempt's outcome, fenced by its lease (#8), in one transaction
   * with its row in the attempt log. Completion: the step becomes `completed`
   * with its remote identifier and pins, and the next step `ready` if its
   * event is stored, else the case waits for it. Dead-lettering: the step and
   * its case become `dead_lettered` with the reason; the rest of the case is
   * held. Resolves to `false` when the claim no longer holds the lease: the
   * step is unchanged and the attempt is logged as `discarded`.
   */
  storeOutcome(step: ClaimedStep, outcome: StepOutcome): Promise<boolean>;
  /**
   * Logs an attempt that ended without an outcome. The step is unchanged: it
   * stays `in_flight` until its lease expires (retries land with #35).
   */
  recordFailedAttempt(step: ClaimedStep, facts: AttemptFacts): Promise<void>;
}

/** Builds the outbox over the hub database. Only the composition root calls this. */
export function createOutbox(deps: { db: Kysely<Database>; clock: Clock; leaseMs: number }): Outbox {
  const { db, clock, leaseMs } = deps;

  /** Appends the attempt's row to the attempt log. */
  const logAttempt = (
    // A transaction is a Kysely too: the row commits with whatever the caller's transaction changed.
    trx: Kysely<Database>,
    step: ClaimedStep,
    endedAt: Date,
    row: { outcome: AttemptOutcome; errorCode: DeadLetterReason | null; facts: AttemptFacts },
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
      })
      .execute();

  /** The fence: this step, still in flight, still under this claim's token. */
  const holding = (trx: Transaction<Database>, step: ClaimedStep) =>
    trx
      .updateTable('step')
      .where('case_id', '=', step.caseId)
      .where('seq', '=', step.seq)
      .where('state', '=', 'in_flight')
      .where('lease_token', '=', step.leaseToken);

  return {
    async claim() {
      const now = clock();
      // One statement: pick the oldest claimable row, skip rows another
      // worker has locked, and take it under a fresh lease token. An expired
      // lease is claimable again; the stale holder's outcome then fails the fence.
      // The row type brands what the columns hold: ids Postgres generated or
      // ingest stored from a validated event, and the token gen_random_uuid() just issued.
      const { rows } = await sql<Omit<ClaimedStep, 'startedAt'>>`
        with picked as (
          select case_id, seq
            from step
           where state = 'ready'
              or (state = 'in_flight' and lease_expires_at <= ${now})
           order by updated_at
           limit 1
             for update skip locked
        )
        update step s
           set state = 'in_flight',
               attempts = s.attempts + 1,
               lease_token = gen_random_uuid(),
               lease_expires_at = ${new Date(now.getTime() + leaseMs)},
               updated_at = ${now}
          from picked, "case" c
         where s.case_id = picked.case_id
           and s.seq = picked.seq
           and c.id = s.case_id
        returning s.case_id as "caseId", s.seq, s.name, s.attempts as attempt, s.lease_token as "leaseToken",
                  c.source_system_id as "sourceSystemId", c.organization_id as "organizationId", c.visit_id as "visitId"
      `.execute(db);
      const [row] = rows;
      return row && { ...row, startedAt: now };
    },

    storeOutcome: (step, outcome) =>
      // Lock the case row (as ingest does, so an arriving event and an outcome
      // apply one at a time), change the step only if the claim still holds
      // its lease, store the re-derived case status, and log the attempt.
      db.transaction().execute(async (trx) => {
        const now = clock();
        await trx.selectFrom('case').select('id').where('id', '=', step.caseId).forUpdate().executeTakeFirstOrThrow();
        const before = await readSteps(trx, step.caseId);
        const { change, after, outcome: logged, errorCode } =
          'completed' in outcome
            ? {
                change: {
                  state: 'completed' as const,
                  remote_type: outcome.completed.type,
                  remote_id: outcome.completed.id,
                  remote_version: outcome.completed.version,
                  pins: JSON.stringify(outcome.pins),
                },
                after: () => applyCompletion(before, step.seq),
                outcome: 'completed' as const,
                errorCode: null,
              }
            : {
                change: { state: 'dead_lettered' as const, dead_letter_reason: outcome.deadLettered },
                after: () => before.map((s): StepView => (s.seq === step.seq ? { seq: s.seq, state: 'dead_lettered' } : s)),
                outcome: 'dead_lettered' as const,
                errorCode: outcome.deadLettered,
              };
        const updated = await holding(trx, step)
          .set(change)
          .set({ lease_token: null, lease_expires_at: null, updated_at: now })
          .executeTakeFirst();
        if (updated.numUpdatedRows === 0n) {
          await logAttempt(trx, step, now, { outcome: 'discarded', errorCode, facts: outcome.attempt });
          return false;
        }

        const next = after();
        for (const s of next) {
          if (s.seq === step.seq || before.find((b) => b.seq === s.seq)?.state === s.state) continue;
          await trx
            .updateTable('step')
            .set({ state: s.state, updated_at: now })
            .where('case_id', '=', step.caseId)
            .where('seq', '=', s.seq)
            .execute();
        }
        await writeCaseStatus(trx, step.caseId, next, now);
        await logAttempt(trx, step, now, { outcome: logged, errorCode, facts: outcome.attempt });
        return true;
      }),

    async recordFailedAttempt(step, facts) {
      await logAttempt(db, step, clock(), { outcome: 'failed', errorCode: null, facts });
    },
  };
}
