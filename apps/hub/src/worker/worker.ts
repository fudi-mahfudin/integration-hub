import type { StepName } from '../cases/case-model.js';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import type { AttemptOutcome } from '../db/database.js';
import type { IhsNumberCache } from '../ihs-cache/ihs-number-cache.js';
import type { Log } from '../observability/log.js';
import { failSpan, inCaseTrace, inSpan, recordEndedSpan } from '../observability/tracing.js';
import type { CircuitBreaker } from '../satusehat/circuit-breaker.js';
import type { ClaimedStep, Outbox } from '../outbox/outbox.js';
import { AttemptAborted, SatusehatRequestError } from '../satusehat/errors.js';
import type { AttemptCalls } from '../satusehat/transport.js';
import { AttemptFailed, newAttemptFacts, type AttemptFacts, type StepOutcome } from '../steps/step-outcome.js';
import { classifyFailure } from './failure-class.js';

/** Logged when a claim that lost its lease reaches an outcome. */
const OUTCOME_DISCARDED = 'the lease was lost before the outcome was stored; the outcome is discarded';

/**
 * How an attempt ended, on its `step.attempt` span (#42): its outcome in the
 * attempt log, `lease_lost` when the lease was lost before the outcome was
 * stored, or `unrecorded` when nothing was stored (no runner, or storing failed).
 */
type AttemptSpanOutcome = Exclude<AttemptOutcome, 'discarded' | 'lease_expired'> | 'lease_lost' | 'unrecorded';

/** Carries out one attempt at a step it holds the lease on; its SATUSEHAT calls share `calls`. */
export type StepRunner = (step: ClaimedStep, calls: AttemptCalls) => Promise<StepOutcome>;

/** A worker: claims steps from the outbox one at a time and carries them out. */
export interface Worker {
  /** Starts claiming. */
  start(): void;
  /** Stops claiming and resolves once the attempt in progress, if any, has ended. */
  stop(): Promise<void>;
  /**
   * Stops claiming and aborts the attempt in progress, if any, at a drain
   * deadline (#43): its calls are cut, and it releases its step as
   * `worker_shutdown`. Resolve `stop()` to know when it has.
   */
  abort(): void;
}

/**
 * Builds the worker loop: claim a step, run it, apply its outcome through the
 * lease fence; when nothing is claimable, wait `pollIntervalMs`. An attempt
 * that throws is classified (#13): a permanent failure dead-letters the step,
 * a transient one sends it to `retry_wait` (or, on its last allowed attempt,
 * dead-letters it `RETRIES_EXHAUSTED`). While any of `breakers` is open, it
 * claims nothing (#13), so a down platform consumes no attempts. A
 * permanent rejection of a write deletes every IHS-number cache entry its
 * attempt used (#47), since one of them may be what SATUSEHAT refused; a
 * transient failure deletes nothing.
 *
 * Each claim is traced (#42) in the trace of the ingest span that accepted
 * the step's event: a `step.claim` span, then a `step.attempt` span over the
 * attempt, both children of that ingest span. A poll that claims nothing makes no span.
 */
export function createWorkerLoop(deps: {
  outbox: Outbox;
  runners: Partial<Record<StepName, StepRunner>>;
  /** The process's circuit breakers, one per platform API. */
  breakers: readonly CircuitBreaker[];
  pollIntervalMs: number;
  /** How long one attempt may go on making calls (#13). */
  attemptBudgetMs: number;
  ihsCache: Pick<IhsNumberCache, 'forget'>;
  log: Log;
}): Worker {
  const { outbox, runners, breakers, pollIntervalMs, attemptBudgetMs, ihsCache, log } = deps;
  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  // Aborted once, at the drain deadline: every attempt after it would be cut at once, but none starts.
  const shutdown = new AbortController();

  const idle = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  /** Traces a claim, then carries out its attempt under a `step.attempt` span. */
  function claimed(step: ClaimedStep, claimStartedAt: Date): Promise<void> {
    const attributes = { step: step.name, attempt: step.attempt };
    return inCaseTrace(step.traceparent, step.caseId, async () => {
      recordEndedSpan('step.claim', attributes, claimStartedAt);
      await inSpan('step.attempt', attributes, async (span) => {
        span.setAttribute('outcome', await attempt(step, span));
      });
    });
  }

  async function attempt(step: ClaimedStep, span: Span): Promise<AttemptSpanOutcome> {
    const fields = { caseId: step.caseId, step: step.name, attempt: step.attempt };
    const runner = runners[step.name];
    if (!runner) {
      log('error', 'no runner for a claimed step; it stays in flight until its lease expires', fields);
      return 'unrecorded';
    }
    const calls: AttemptCalls = { budgetEndsAt: new Date(step.startedAt.getTime() + attemptBudgetMs), readRetries: [], signal: shutdown.signal };
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
        return stored === 'lease_lost' ? 'lease_lost' : 'failed';
      }
      if (!(await outbox.storeOutcome(step, outcome, calls.readRetries))) {
        log('warn', OUTCOME_DISCARDED, fields);
        return 'lease_lost';
      }
      if ('deadLettered' in outcome) {
        log('error', 'step dead-lettered', { ...fields, errorCode: outcome.deadLettered });
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.deadLettered });
        return 'dead_lettered';
      }
      return 'completed';
    } catch (err) {
      failSpan(span, err);
      const facts = failedAttemptFacts(err);
      // Only a call the drain deadline cut: an attempt that failed on its own just as it struck is stored as it failed.
      if (err instanceof AttemptAborted || (err instanceof AttemptFailed && err.cause instanceof AttemptAborted)) return releaseAtShutdown(step, facts, calls, err);
      const failure = classifyFailure(err);
      try {
        if ('permanent' in failure) {
          log('error', 'attempt failed permanently; the step is dead-lettered', { ...fields, errorCode: failure.permanent, error: err });
          // The hub doesn't parse the OperationOutcome to guess which reference was wrong (#20): every entry goes.
          if (isWriteRejection(err)) await ihsCache.forget(facts.cacheKeys);
          if (!(await outbox.storeOutcome(step, { deadLettered: failure.permanent, attempt: facts }, calls.readRetries))) {
            log('warn', OUTCOME_DISCARDED, fields);
            return 'lease_lost';
          }
          return 'dead_lettered';
        }
        const stored = await outbox.storeTransient(step, { outcome: failure.transient, facts, readRetries: calls.readRetries, retryAfter: failure.retryAfter, refreshed: null });
        const message = {
          retry_wait: 'attempt failed transiently; the step waits to be retried',
          exhausted: 'attempt failed transiently and was the last allowed; the step is dead-lettered',
          lease_lost: 'attempt failed transiently after its lease was lost; nothing is stored',
        }[stored];
        const errorCode = stored === 'exhausted' ? 'RETRIES_EXHAUSTED' : failure.transient;
        log(stored === 'exhausted' ? 'error' : 'warn', message, { ...fields, errorCode, error: err });
        return stored === 'lease_lost' ? 'lease_lost' : failure.transient;
      } catch (storeErr) {
        // The step stays in flight; its lease expires and another claim takes it over as `lease_expired`.
        log('error', 'storing the failed attempt failed; the step is retried once its lease expires', { ...fields, error: storeErr, attemptError: err });
        return 'unrecorded';
      }
    }
  }

  /** Releases a step whose attempt the drain deadline cut short (#43); if that fails, its lease expires instead. */
  async function releaseAtShutdown(step: ClaimedStep, facts: AttemptFacts, calls: AttemptCalls, err: unknown): Promise<AttemptSpanOutcome> {
    const fields = { caseId: step.caseId, step: step.name, attempt: step.attempt };
    try {
      if (!(await outbox.release(step, { facts, readRetries: calls.readRetries }))) {
        log('warn', 'the lease was lost before the shutdown release was stored; nothing is stored', fields);
        return 'lease_lost';
      }
      log('warn', 'attempt cut short by the drain deadline; the step is released to be claimed again at once', { ...fields, error: err });
      return 'worker_shutdown';
    } catch (storeErr) {
      // The step stays in flight; its lease expires and another claim takes it over as `lease_expired`.
      log('error', 'releasing the step at shutdown failed; it is retried once its lease expires', { ...fields, error: storeErr, attemptError: err });
      return 'unrecorded';
    }
  }

  async function run(): Promise<void> {
    while (running) {
      let step: ClaimedStep | undefined;
      if (breakers.some((b) => b.isOpen())) {
        await idle();
        continue;
      }
      // The wall clock, as every span is timed: when the claim span started.
      const claimStartedAt = new Date();
      try {
        step = await outbox.claim();
      } catch (err) {
        // The next poll claims again; nothing was taken.
        log('error', 'claiming a step failed', { error: err });
      }
      if (step) await claimed(step, claimStartedAt);
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
    abort() {
      running = false;
      wake?.();
      shutdown.abort();
    },
  };
}

/** Whether SATUSEHAT answered one of the step's writes (a POST or PUT) with the status that failed the attempt. */
function isWriteRejection(err: unknown): boolean {
  const cause = err instanceof AttemptFailed ? err.cause : err;
  return cause instanceof SatusehatRequestError && (cause.method === 'POST' || cause.method === 'PUT');
}

/** What a failed attempt had resolved, and the status SATUSEHAT answered when a request was what failed. */
function failedAttemptFacts(err: unknown): AttemptFacts {
  const facts: AttemptFacts =
    err instanceof AttemptFailed ? err.facts : newAttemptFacts();
  const cause = err instanceof AttemptFailed ? err.cause : err;
  return cause instanceof SatusehatRequestError ? { ...facts, httpStatus: cause.status } : facts;
}
