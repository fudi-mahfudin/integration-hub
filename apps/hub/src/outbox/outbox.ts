import { sql, type Kysely, type Transaction } from 'kysely';
import { applyCompletion, type StepView } from '../cases/case-model.js';
import { readSteps, writeDerivedStatus } from '../cases/case-status.js';
import type { Database } from '../db/database.js';
import type { Clock } from '../tokens.js';

/**
 * The Postgres outbox (ADR 0002). A step row is its own outbox entry: ingest
 * and completion make it `ready` in the transaction that makes it eligible,
 * and workers take it from here under a lease.
 */

/** A step a worker holds under a lease. Every outcome must present `leaseToken`. */
export interface ClaimedStep {
  caseId: string;
  seq: number;
  name: string;
  /** This claim's attempt number (the counter increments on claim, #8). */
  attempt: number;
  leaseToken: string;
  sourceId: string;
  organizationId: string;
  visitId: string;
  /** When this claim started: the attempt's start time. */
  claimedAt: Date;
}

export interface RemoteIdentifier {
  type: string;
  id: string;
  version: string | null;
}

/** What an attempt leaves in the step's append-only attempt log (#8, #28), besides its outcome. */
export interface AttemptRecord {
  /** The dead-letter reason, or the transient failure's code once #35 classifies them. */
  errorCode: string | null;
  /** The last platform answer's HTTP status, if the attempt got one. */
  httpStatus: number | null;
  /** Values the attempt resolved and used, with the lookup method (#10). */
  used: Record<string, unknown>;
  /** Every Validation violation, in rule order (#9). */
  violations: readonly unknown[];
  detail: string | null;
}

/** Values a completed step sent (#10). Later steps read these, never the live mappings. */
export type Pins = Record<string, unknown>;

export interface Outbox {
  /** Claims one claimable step, skipping rows other workers hold; undefined when none. */
  claim(): Promise<ClaimedStep | undefined>;
  /**
   * Lease-fenced completion (#8): one transaction that stores the remote
   * identifier and the pins, releases the next step or makes the case wait.
   * Each outcome also appends the attempt to the attempt log, in the same transaction.
   * @returns false when the lease was lost; the result is discarded.
   */
  complete(step: ClaimedStep, remote: RemoteIdentifier, pins: Pins, record: AttemptRecord): Promise<boolean>;
  /** Lease-fenced permanent failure; holds the rest of the case. False when the lease was lost. */
  deadLetter(step: ClaimedStep, reason: string, record: AttemptRecord): Promise<boolean>;
  /** Lease-fenced transient failure: claimable again at `availableAt`. False when the lease was lost. */
  retryAt(step: ClaimedStep, availableAt: Date, record: AttemptRecord): Promise<boolean>;
}

export function createOutbox({ db, clock, leaseMs }: { db: Kysely<Database>; clock: Clock; leaseMs: number }): Outbox {
  /**
   * Locks the case row first (as ingest does), then applies `change` to the
   * step only if this claim still holds its lease. Returns the steps after.
   */
  const fenced = async (
    step: ClaimedStep,
    outcome: 'completed' | 'dead_lettered' | 'retry_wait',
    record: AttemptRecord,
    change: (trx: Transaction<Database>, now: Date) => Promise<boolean>,
    nextSteps: (steps: StepView[]) => StepView[] = (s) => s,
  ): Promise<boolean> =>
    db.transaction().execute(async (trx) => {
      const now = clock();
      const kase = await trx
        .selectFrom('case')
        .select(['id', 'waiting_for', 'waiting_since'])
        .where('id', '=', step.caseId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!(await change(trx, now))) return false;
      await trx
        .insertInto('step_attempt')
        .values({
          case_id: step.caseId,
          seq: step.seq,
          attempt: step.attempt,
          started_at: step.claimedAt,
          ended_at: now,
          outcome,
          error_code: record.errorCode,
          http_status: record.httpStatus,
          used: JSON.stringify(record.used),
          violations: JSON.stringify(record.violations),
          detail: record.detail,
        })
        .execute();
      const before = await readSteps(trx, step.caseId);
      const after = nextSteps(before);
      for (const s of after) {
        if (before.find((b) => b.seq === s.seq)?.state === s.state) continue;
        await trx
          .updateTable('step')
          .set({ state: s.state, updated_at: now })
          .where('case_id', '=', step.caseId)
          .where('seq', '=', s.seq)
          .execute();
      }
      await writeDerivedStatus(trx, kase, after, now);
      return true;
    });

  /** The fence itself: this step, still in flight, still under this claim's token. */
  const holding = (step: ClaimedStep) => (trx: Transaction<Database>) =>
    trx
      .updateTable('step')
      .where('case_id', '=', step.caseId)
      .where('seq', '=', step.seq)
      .where('state', '=', 'in_flight')
      .where('lease_token', '=', step.leaseToken);

  return {
    async claim() {
      const now = clock();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      // One statement: pick the oldest claimable row, skipping rows another
      // worker has locked, and take it under a fresh lease token. An expired
      // lease is claimable again (its attempt is already counted).
      const { rows } = await sql<ClaimedStep>`
        update step s
           set state = 'in_flight',
               attempts = s.attempts + 1,
               lease_token = gen_random_uuid(),
               lease_expires_at = ${leaseExpiresAt},
               available_at = null,
               claimed_at = ${now},
               updated_at = ${now}
          from (
                select case_id, seq
                  from step
                 where state = 'ready'
                    or (state = 'retry_wait' and available_at <= ${now})
                    or (state = 'in_flight' and lease_expires_at <= ${now})
                 order by updated_at
                 limit 1
                   for update skip locked
               ) picked,
               "case" k
         where s.case_id = picked.case_id
           and s.seq = picked.seq
           and k.id = s.case_id
     returning s.case_id as "caseId", s.seq, s.name, s.attempts as attempt, s.lease_token as "leaseToken",
               k.source_id as "sourceId", k.organization_id as "organizationId", k.visit_id as "visitId", s.claimed_at as "claimedAt"
      `.execute(db);
      return rows[0];
    },

    complete: (step, remote, pins, record) =>
      fenced(
        step,
        'completed',
        record,
        async (trx, now) => {
          const r = await holding(step)(trx)
            .set({
              state: 'completed',
              remote_type: remote.type,
              remote_id: remote.id,
              remote_version: remote.version,
              pins: JSON.stringify(pins),
              lease_token: null,
              lease_expires_at: null,
              updated_at: now,
            })
            .executeTakeFirst();
          return r.numUpdatedRows > 0n;
        },
        // The fenced update already wrote `completed`; release the next step.
        (steps) => applyCompletion(steps, step.seq),
      ),

    deadLetter: (step, reason, record) =>
      fenced(step, 'dead_lettered', record, async (trx, now) => {
        const r = await holding(step)(trx)
          .set({ state: 'dead_lettered', dead_letter_reason: reason, lease_token: null, lease_expires_at: null, updated_at: now })
          .executeTakeFirst();
        return r.numUpdatedRows > 0n;
      }),

    retryAt: (step, availableAt, record) =>
      fenced(step, 'retry_wait', record, async (trx, now) => {
        const r = await holding(step)(trx)
          .set({ state: 'retry_wait', available_at: availableAt, lease_token: null, lease_expires_at: null, updated_at: now })
          .executeTakeFirst();
        return r.numUpdatedRows > 0n;
      }),
  };
}
