import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { CaseStatus, DeadLetterReason, EventType, StepName } from '../cases/case-model.js';
import { CASE_STATUSES, STEPS } from '../cases/case-model.js';
import type { ProblemCode } from '../http/problem.js';
import type { CacheName, CacheResult } from '../ihs-cache/ihs-number-cache.js';
import type { AbandonableStatus } from '../cases/operator-actions.js';
import { DIVERGENCE_CLASSES, type DivergenceClass, type ENDED_RUN_STATUSES, type ReconciliationCheckOutcome } from '../reconciliation/model.js';
import type { RunTrigger } from '../reconciliation/runs.js';
import type { PlatformApi } from '../satusehat/circuit-breaker.js';
import type { RateLimitedApi } from '../satusehat/rate-limiter.js';

/*
 * The metric catalogue of #15, #17 and #20, unprefixed with units in the
 * name. The catalogue's wire names say `upstream` (`upstream_request_duration_seconds`,
 * the `upstream` label); in code the concept is a platform API (GLOSSARY.md).
 * Every label value comes from a closed set, typed here, so no case id,
 * visit id, person identifier, remote identifier, code or URL path can become
 * a label (#15). One registry per process instance: a test boots a hub
 * service and a worker in one Node process, and each exposes only its own.
 */

/** What a process's `GET /metrics` answers. */
export interface MetricsExposition {
  /** The Prometheus text format's content type. */
  readonly contentType: string;
  /** The process's metrics now, in the Prometheus text format; the hub service reads its database-derived gauges first. */
  scrape(): Promise<string>;
}

/** The status of an ingest request, by the event type its body named; `unknown` when it named none or was never read (authentication failed). */
export type IngestEventType = EventType | 'unknown';

/** What the hub service records: ingest and operator actions. */
export interface HubMetrics extends MetricsExposition {
  /** One `POST /v1/events` answered with HTTP `status` after `seconds`. */
  ingestRequest(eventType: IngestEventType, status: number, seconds: number): void;
  /** One ingest request rejected with a problem `code`. */
  ingestRejected(code: ProblemCode): void;
  /** One duplicate ingest, answered with the original answer. */
  ingestDuplicate(eventType: EventType): void;
  /** One case abandoned by an operator. */
  caseAbandoned(previousStatus: AbandonableStatus): void;
}

/** The outbox state of one step name, as the hub service's gauges show it. */
export interface OutboxGauges {
  /** Claimable steps: `ready`, or `retry_wait` whose `available_at` has come. */
  claimable: number;
  /** How long the oldest claimable step has been claimable, in seconds; 0 when none is. */
  lagSeconds: number;
}

/** The database state the hub service's gauges show, read at scrape time. */
export interface DatabaseGauges {
  /** How many cases are in each status. */
  cases: Record<CaseStatus, number>;
  /** Waiting cases past the stalled threshold (ADR 0007). */
  casesStalled: number;
  /** How long the longest-dead-lettered case has been, in seconds; 0 when none is. */
  deadLetteredOldestAgeSeconds: number;
  outbox: Record<StepName, OutboxGauges>;
  /** The divergences of the latest completed reconciliation run, by class; all 0 when none has completed. */
  divergences: Record<DivergenceClass, number>;
  /** When the latest completed reconciliation run ended, in Unix seconds; null when none has. */
  reconciliationLastCompletedSeconds: number | null;
}

/** How a step attempt ended (#15): `worker_shutdown` is an attempt a draining worker released at its deadline (#43). */
export type AttemptMetricOutcome = 'success' | 'transient' | 'permanent' | 'lease_expired' | 'worker_shutdown';

/** What kind of call a platform API request is: FHIR searches (every FHIR read), creates and updates, KFA lookups, token requests. */
export type PlatformOperation = 'search' | 'create' | 'update' | 'token' | 'lookup';

/** How a platform API request ended: by its status's class (429 apart), or without an answer. */
export type PlatformStatusClass = '2xx' | '4xx' | '429' | '5xx' | 'timeout' | 'network';

/** A circuit breaker's state; the gauge shows it as 0, 1, 2. */
export type BreakerState = 'closed' | 'half_open' | 'open';

/** Which bucket a rate limiter wait came from: the shared one in Redis, or the process's own while Redis is unreachable. */
export type LimiterMode = 'redis' | 'local_fallback';

/** How a reconciliation run ended: one of the ended run statuses. */
export type RunMetricOutcome = (typeof ENDED_RUN_STATUSES)[number];

/** Starts timing now; the function returned gives the seconds since, for a histogram. */
export function stopwatch(): () => number {
  const startedAt = performance.now();
  return () => (performance.now() - startedAt) / 1000;
}

/** What a worker records: the work it does. */
export interface WorkerMetrics extends MetricsExposition {
  /** One step attempt that ended `outcome` after `seconds`. */
  stepAttempt(step: StepName, outcome: AttemptMetricOutcome, seconds: number): void;
  /** One step completed. */
  stepCompleted(step: StepName): void;
  /** One step dead-lettered with `reason`. */
  stepDeadLettered(step: StepName, reason: DeadLetterReason): void;
  /** One HTTP exchange with a platform API, ended `statusClass` after `seconds`. */
  platformRequest(upstream: PlatformApi, operation: PlatformOperation, statusClass: PlatformStatusClass, seconds: number): void;
  /** A platform API's breaker opened. */
  breakerOpened(upstream: PlatformApi): void;
  /** A call to `upstream` waited `seconds` (often 0) for its turn under the rate limit. */
  limiterWaited(upstream: RateLimitedApi, mode: LimiterMode, seconds: number): void;
  /** One request to an IHS-number cache (#20, #47). */
  cacheRequest(cache: CacheName, result: CacheResult): void;
  /** One reconciliation run this worker executed, ended `outcome` after `seconds`. */
  reconciliationRun(trigger: RunTrigger, outcome: RunMetricOutcome, seconds: number): void;
  /** One reconciliation check of a case; a `clean` check counts as `result="ok"` (#17). */
  reconciliationCheck(outcome: ReconciliationCheckOutcome): void;
}

/** Seconds-scale buckets from 5ms to 60s: ingest, attempts, upstream calls and limiter waits all fall in them. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
/** Reconciliation runs take minutes against the sandbox. */
const RUN_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800];

const BREAKER_STATE_VALUE: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };

/**
 * Builds the hub service's metrics. `readDatabaseGauges` runs on every
 * scrape, so the database-derived gauges (#15) are as of the scrape, and only
 * the hub service shows them: nothing is counted twice across processes.
 * Only the composition root calls this.
 */
export function createHubMetrics(deps: { readDatabaseGauges: () => Promise<DatabaseGauges> }): HubMetrics {
  const registry = new Registry();
  const registers = [registry];
  const ingestDuration = new Histogram({
    name: 'ingest_request_duration_seconds',
    help: 'POST /v1/events requests by event type and HTTP status; rate and errors from _count.',
    labelNames: ['event_type', 'status'] as const,
    buckets: DURATION_BUCKETS,
    registers,
  });
  const rejections = new Counter({ name: 'ingest_rejections_total', help: 'Ingest requests rejected, by problem code.', labelNames: ['code'] as const, registers });
  const duplicates = new Counter({ name: 'ingest_duplicates_total', help: 'Duplicate ingests answered with the original answer, by event type.', labelNames: ['event_type'] as const, registers });
  const abandoned = new Counter({ name: 'cases_abandoned_total', help: 'Cases abandoned by an operator, by their status before.', labelNames: ['previous_status'] as const, registers });
  const cases = new Gauge({ name: 'cases', help: 'Cases by status.', labelNames: ['status'] as const, registers });
  const stalled = new Gauge({ name: 'cases_stalled', help: 'Waiting cases past the stalled threshold.', registers });
  const deadLetteredAge = new Gauge({ name: 'cases_dead_lettered_oldest_age_seconds', help: 'How long the longest-dead-lettered case has been; 0 when none is.', registers });
  const outboxLag = new Gauge({ name: 'outbox_lag_seconds', help: 'How long the oldest claimable step has been claimable; 0 when none is.', labelNames: ['step'] as const, registers });
  const claimable = new Gauge({ name: 'outbox_claimable_steps', help: 'Steps ready, or in retry_wait past available_at.', labelNames: ['step'] as const, registers });
  const divergences = new Gauge({ name: 'reconciliation_divergences', help: 'Divergences of the latest completed reconciliation run, by class.', labelNames: ['class'] as const, registers });
  // Registered only once a run has completed: a gauge without labels always shows a value, and 0 would read as 1970.
  const LAST_COMPLETED_NAME = 'reconciliation_last_completed_timestamp_seconds';
  const lastCompleted = new Gauge({ name: LAST_COMPLETED_NAME, help: 'When the latest completed reconciliation run ended; absent until one has.', registers: [] });

  return {
    contentType: registry.contentType,
    async scrape() {
      const gauges = await deps.readDatabaseGauges();
      for (const status of CASE_STATUSES) cases.set({ status }, gauges.cases[status]);
      stalled.set(gauges.casesStalled);
      deadLetteredAge.set(gauges.deadLetteredOldestAgeSeconds);
      for (const { name } of STEPS) {
        outboxLag.set({ step: name }, gauges.outbox[name].lagSeconds);
        claimable.set({ step: name }, gauges.outbox[name].claimable);
      }
      for (const cls of DIVERGENCE_CLASSES) divergences.set({ class: cls }, gauges.divergences[cls]);
      const registered = registry.getSingleMetric(LAST_COMPLETED_NAME) !== undefined;
      if (gauges.reconciliationLastCompletedSeconds === null) {
        if (registered) registry.removeSingleMetric(LAST_COMPLETED_NAME);
      } else {
        if (!registered) registry.registerMetric(lastCompleted);
        lastCompleted.set(gauges.reconciliationLastCompletedSeconds);
      }
      return registry.metrics();
    },
    ingestRequest: (eventType, status, seconds) => ingestDuration.observe({ event_type: eventType, status: String(status) }, seconds),
    ingestRejected: (code) => rejections.inc({ code }),
    ingestDuplicate: (eventType) => duplicates.inc({ event_type: eventType }),
    caseAbandoned: (previousStatus) => abandoned.inc({ previous_status: previousStatus }),
  };
}

/**
 * Builds a worker's metrics. `breakerStates` is read on every scrape. Only
 * the composition root calls this.
 */
export function createWorkerMetrics(deps: { breakerStates: () => Record<PlatformApi, BreakerState> }): WorkerMetrics {
  const registry = new Registry();
  const registers = [registry];
  const attempts = new Counter({ name: 'step_attempts_total', help: 'Step attempts by step and outcome.', labelNames: ['step', 'outcome'] as const, registers });
  const attemptDuration = new Histogram({
    name: 'step_attempt_duration_seconds',
    help: 'Step attempt duration by step and outcome.',
    labelNames: ['step', 'outcome'] as const,
    buckets: DURATION_BUCKETS,
    registers,
  });
  const completed = new Counter({ name: 'steps_completed_total', help: 'Steps completed.', labelNames: ['step'] as const, registers });
  const deadLettered = new Counter({ name: 'steps_dead_lettered_total', help: 'Steps dead-lettered, by reason.', labelNames: ['step', 'reason'] as const, registers });
  const upstream = new Histogram({
    name: 'upstream_request_duration_seconds',
    help: 'HTTP exchanges with SATUSEHAT by platform API, operation and status class.',
    labelNames: ['upstream', 'operation', 'status_class'] as const,
    buckets: DURATION_BUCKETS,
    registers,
  });
  const breakerState = new Gauge({ name: 'circuit_breaker_state', help: 'Circuit breaker state per platform API: 0 closed, 1 half-open, 2 open.', labelNames: ['upstream'] as const, registers });
  const breakerOpens = new Counter({ name: 'circuit_breaker_opens_total', help: 'Times a platform API breaker opened.', labelNames: ['upstream'] as const, registers });
  const limiterWait = new Histogram({
    name: 'rate_limiter_wait_seconds',
    help: 'How long calls waited for the rate limit, by platform API and bucket mode.',
    labelNames: ['upstream', 'mode'] as const,
    buckets: [0, ...DURATION_BUCKETS],
    registers,
  });
  const cache = new Counter({ name: 'cache_requests_total', help: 'Cache requests by cache and result.', labelNames: ['cache', 'result'] as const, registers });
  const runs = new Counter({ name: 'reconciliation_runs_total', help: 'Reconciliation runs executed, by trigger and outcome.', labelNames: ['trigger', 'outcome'] as const, registers });
  const runDuration = new Histogram({ name: 'reconciliation_run_duration_seconds', help: 'Reconciliation run duration.', buckets: RUN_BUCKETS, registers });
  const checks = new Counter({ name: 'reconciliation_checks_total', help: 'Reconciliation checks by result.', labelNames: ['result'] as const, registers });

  return {
    contentType: registry.contentType,
    async scrape() {
      for (const [api, state] of Object.entries(deps.breakerStates())) breakerState.set({ upstream: api }, BREAKER_STATE_VALUE[state]);
      return registry.metrics();
    },
    stepAttempt(step, outcome, seconds) {
      attempts.inc({ step, outcome });
      attemptDuration.observe({ step, outcome }, seconds);
    },
    stepCompleted: (step) => completed.inc({ step }),
    stepDeadLettered: (step, reason) => deadLettered.inc({ step, reason }),
    platformRequest: (api, operation, statusClass, seconds) => upstream.observe({ upstream: api, operation, status_class: statusClass }, seconds),
    breakerOpened: (api) => breakerOpens.inc({ upstream: api }),
    limiterWaited: (api, mode, seconds) => limiterWait.observe({ upstream: api, mode }, seconds),
    cacheRequest: (name, result) => cache.inc({ cache: name, result }),
    reconciliationRun(trigger, outcome, seconds) {
      runs.inc({ trigger, outcome });
      runDuration.observe(seconds);
    },
    reconciliationCheck: (outcome) => checks.inc({ result: outcome === 'clean' ? 'ok' : outcome }),
  };
}
