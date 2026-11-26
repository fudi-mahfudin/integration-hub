import type { StepName } from '../cases/case-model.js';
import { log } from '../observability/log.js';
import type { ClaimedStep, Outbox } from '../outbox/outbox.js';
import { SatusehatRequestError } from '../satusehat/errors.js';
import { AttemptFailed, type AttemptFacts, type StepOutcome } from '../steps/step-outcome.js';

/** Carries out one attempt at a step it holds the lease on. */
export type StepRunner = (step: ClaimedStep) => Promise<StepOutcome>;

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
 * that throws is logged and its step stays `in_flight`, so it becomes
 * claimable again when its lease expires (failure classification and retries
 * land with #35).
 */
export function createWorkerLoop(deps: {
  outbox: Outbox;
  runners: Partial<Record<StepName, StepRunner>>;
  pollIntervalMs: number;
}): Worker {
  const { outbox, runners, pollIntervalMs } = deps;
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
    try {
      const outcome = await runner(step);
      if (!(await outbox.storeOutcome(step, outcome))) {
        log('warn', 'the lease was lost before the outcome was stored; the outcome is discarded', fields);
      } else if ('deadLettered' in outcome) {
        log('warn', 'step dead-lettered', { ...fields, reason: outcome.deadLettered });
      }
    } catch (err) {
      log('error', 'attempt failed; the step stays in flight until its lease expires', { ...fields, error: err });
      try {
        await outbox.recordFailedAttempt(step, failedAttemptFacts(err));
      } catch (logErr) {
        // The failure itself is logged above; only its attempt-log row is missing.
        log('error', 'logging the failed attempt failed', { ...fields, error: logErr });
      }
    }
  }

  async function run(): Promise<void> {
    while (running) {
      let step: ClaimedStep | undefined;
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
