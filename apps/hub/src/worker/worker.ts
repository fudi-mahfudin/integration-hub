import type { StepName } from '../cases/case-model.js';
import { log } from '../observability/log.js';
import type { CircuitBreaker } from '../satusehat/circuit-breaker.js';
import type { ClaimedStep, Outbox } from '../outbox/outbox.js';
import { SatusehatRequestError } from '../satusehat/errors.js';
import type { AttemptCalls } from '../satusehat/transport.js';
import { AttemptFailed, type AttemptFacts, type StepOutcome } from '../steps/step-outcome.js';
import { classifyFailure } from './failure-class.js';

/** Logged when a claim that lost its lease reaches an outcome. */
const OUTCOME_DISCARDED = 'the lease was lost before the outcome was stored; the outcome is discarded';

/** Carries out one attempt at a step it holds the lease on; its SATUSEHAT calls share `calls`. */
export type StepRunner = (step: ClaimedStep, calls: AttemptCalls) => Promise<StepOutcome>;

/** A worker: claims steps from the outbox one at a time and carries them out. */
export interface Worker {
  /** Starts claiming. */
  start(): void;
  /** Stops claiming and resolves once the attempt in progress, if any, has ended. */
  stop(): Promise<void>;
}

/**
 * Builds the worker loop: claim a step, run it, apply its outcome through the
 * lease fence; when nothing is claimable, wait `pollIntervalMs`. An attempt
 * that throws is classified (#13): a permanent failure dead-letters the step,
 * a transient one sends it to `retry_wait` (or, on its last allowed attempt,
 * dead-letters it `RETRIES_EXHAUSTED`). While any of `breakers` is open, it
 * claims nothing (#13), so a down platform consumes no attempts.
 */
export function createWorkerLoop(deps: {
  outbox: Outbox;
  runners: Partial<Record<StepName, StepRunner>>;
  /** The process's circuit breakers, one per platform API. */
  breakers: readonly CircuitBreaker[];
  pollIntervalMs: number;
  /** How long one attempt may go on making calls (#13). */
  attemptBudgetMs: number;
}): Worker {
  const { outbox, runners, breakers, pollIntervalMs, attemptBudgetMs } = deps;
  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  const idle = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function attempt(step: ClaimedStep): Promise<void> {
    const fields = { caseId: step.caseId, step: step.name, attempt: step.attempt };
    const runner = runners[step.name];
    if (!runner) {
      log('error', 'no runner for a claimed step; it stays in flight until its lease expires', fields);
      return;
    }
    const calls: AttemptCalls = { budgetEndsAt: new Date(step.startedAt.getTime() + attemptBudgetMs), readRetries: [] };
    try {
      const outcome = await runner(step, calls);
      if ('staleRemote' in outcome) {
        const { step: storedBy, was, now } = outcome.staleRemote;
        log('warn', 'a stored remote identifier is stale; it is refreshed to the one found and the step retried', {
          ...fields,
          storedBy,
          staleId: was.id,
          refreshedId: now.id,
        });
        const stored = await outbox.storeTransient(step, {
          outcome: 'failed',
          facts: outcome.attempt,
          readRetries: calls.readRetries,
          retryAfter: null,
          refreshed: { step: storedBy, remote: now },
        });
        if (stored === 'lease_lost') log('warn', 'the lease was lost before the refresh was stored; nothing is stored', fields);
        return;
      }
      if (!(await outbox.storeOutcome(step, outcome, calls.readRetries))) {
        log('warn', OUTCOME_DISCARDED, fields);
      } else if ('deadLettered' in outcome) {
        log('warn', 'step dead-lettered', { ...fields, reason: outcome.deadLettered });
      }
    } catch (err) {
      const failure = classifyFailure(err);
      const facts = failedAttemptFacts(err);
      try {
        if ('permanent' in failure) {
          log('warn', 'attempt failed permanently; the step is dead-lettered', { ...fields, reason: failure.permanent, error: err });
          if (!(await outbox.storeOutcome(step, { deadLettered: failure.permanent, attempt: facts }, calls.readRetries))) {
            log('warn', OUTCOME_DISCARDED, fields);
          }
          return;
        }
        const stored = await outbox.storeTransient(step, { outcome: failure.transient, facts, readRetries: calls.readRetries, retryAfter: failure.retryAfter, refreshed: null });
        const message = {
          retry_wait: 'attempt failed transiently; the step waits to be retried',
          exhausted: 'attempt failed transiently and was the last allowed; the step is dead-lettered',
          lease_lost: 'attempt failed transiently after its lease was lost; nothing is stored',
        }[stored];
        log(stored === 'exhausted' ? 'error' : 'warn', message, { ...fields, outcome: failure.transient, error: err });
      } catch (storeErr) {
        // The step stays in flight; its lease expires and another claim takes it over as `lease_expired`.
        log('error', 'storing the failed attempt failed; the step is retried once its lease expires', { ...fields, error: storeErr, attemptError: err });
      }
    }
  }

  async function run(): Promise<void> {
    while (running) {
      let step: ClaimedStep | undefined;
      if (breakers.some((b) => b.isOpen())) {
        await idle();
        continue;
      }
      try {
        step = await outbox.claim();
      } catch (err) {
        // The next poll claims again; nothing was taken.
        log('error', 'claiming a step failed', { error: err });
      }
      if (step) await attempt(step);
      else if (running) await idle();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      wake?.();
      await loop;
    },
  };
}

/** What a failed attempt had resolved, and the status SATUSEHAT answered when a request was what failed. */
function failedAttemptFacts(err: unknown): AttemptFacts {
  const facts: AttemptFacts =
    err instanceof AttemptFailed ? err.facts : { httpStatus: null, valuesUsed: {}, lookupMethods: {}, violations: [] };
  const cause = err instanceof AttemptFailed ? err.cause : err;
  return cause instanceof SatusehatRequestError ? { ...facts, httpStatus: cause.status } : facts;
}
