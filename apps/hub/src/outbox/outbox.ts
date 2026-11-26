import { sql, type Kysely, type Transaction } from 'kysely';
import type { OrganizationId, SourceSystemId } from '../auth/source-systems.js';
import type { Brand } from '../brand.js';
import { applyCompletion, type CaseId, type DeadLetterReason, type StepName, type StepView, type VisitId } from '../cases/case-model.js';
import { readSteps, writeCaseStatus } from '../cases/case-status.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';

/** The token of one claim on a step. An outcome is applied only while it still matches (#8). */
export type LeaseToken = Brand<string, 'LeaseToken'>;

/** A step a worker holds under a lease. */
export interface ClaimedStep {
  caseId: CaseId;
  seq: number;
  name: StepName;
  /** This claim's attempt number: the counter increments on claim (#8). */
  attempt: number;
  leaseToken: LeaseToken;
  sourceSystemId: SourceSystemId;
  /** The case's organization, from its source system's registration (#10). */
  organizationId: OrganizationId;
  visitId: VisitId;
}

/** The record a completed step stored at SATUSEHAT. */
export interface StepRemote {
  type: string;
  id: string;
  version: string | null;
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
   * Lease-fenced completion (#8), one transaction: the step becomes
   * `completed` with its remote identifier, and the next step `ready` if its
   * event is stored, else the case waits for it. Resolves to `false`, having
   * changed nothing, when the claim no longer holds the lease.
   */
  complete(step: ClaimedStep, remote: StepRemote): Promise<boolean>;
  /**
   * Lease-fenced permanent failure: the step and its case become
   * `dead_lettered` with `reason`; the rest of the case is held. Resolves to
   * `false`, having changed nothing, when the claim no longer holds the lease.
   */
  deadLetter(step: ClaimedStep, reason: DeadLetterReason): Promise<boolean>;
}

/** Builds the outbox over the hub database. Only the composition root calls this. */
export function createOutbox(deps: { db: Kysely<Database>; clock: Clock; leaseMs: number }): Outbox {
  const { db, clock, leaseMs } = deps;

  /**
   * Locks the case row (as ingest does, so an arriving event and an outcome
   * apply one at a time), applies `change` to the step only if the claim still
   * holds its lease, then stores the re-derived case status.
   */
  const fenced = (
    step: ClaimedStep,
    change: (trx: Transaction<Database>, now: Date) => Promise<boolean>,
    nextSteps: (steps: StepView[]) => StepView[],
  ): Promise<boolean> =>
    db.transaction().execute(async (trx) => {
      const now = clock();
      await trx.selectFrom('case').select('id').where('id', '=', step.caseId).forUpdate().executeTakeFirstOrThrow();
      const before = await readSteps(trx, step.caseId);
      if (!(await change(trx, now))) return false;
      const after = nextSteps(before);
      for (const s of after) {
        if (s.seq === step.seq || before.find((b) => b.seq === s.seq)?.state === s.state) continue;
        await trx
          .updateTable('step')
          .set({ state: s.state, updated_at: now })
          .where('case_id', '=', step.caseId)
          .where('seq', '=', s.seq)
          .execute();
      }
      await writeCaseStatus(trx, step.caseId, after, now);
      return true;
    });

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
      const { rows } = await sql<ClaimedStep>`
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
      return rows[0];
    },

    complete: (step, remote) =>
      fenced(
        step,
        async (trx, now) => {
          const updated = await holding(trx, step)
            .set({
              state: 'completed',
              remote_type: remote.type,
              remote_id: remote.id,
              remote_version: remote.version,
              lease_token: null,
              lease_expires_at: null,
              updated_at: now,
            })
            .executeTakeFirst();
          return updated.numUpdatedRows > 0n;
        },
        (steps) => applyCompletion(steps, step.seq),
      ),

    deadLetter: (step, reason) =>
      fenced(
        step,
        async (trx, now) => {
          const updated = await holding(trx, step)
            .set({ state: 'dead_lettered', dead_letter_reason: reason, lease_token: null, lease_expires_at: null, updated_at: now })
            .executeTakeFirst();
          return updated.numUpdatedRows > 0n;
        },
        (steps) => steps.map((s) => (s.seq === step.seq ? { seq: s.seq, state: 'dead_lettered' } : s)),
      ),
  };
}
