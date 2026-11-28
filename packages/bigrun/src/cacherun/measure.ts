// What one run of a Cache run measured: from the mock's log (upstream reads),
// the workers' cache counters, and the cases' attempt logs.
import type { LogEntry } from '@integration-hub/mock-satusehat/client';
import type { CaseView } from '../hub-cases.js';
import { percentile, type Judgement } from '../judge.js';
import type { ArmRun } from './judge.js';
import type { ScheduledRun } from './settings.js';

/** The caches the hub counts requests to. */
const CACHES = ['ihs_patient', 'ihs_practitioner'] as const;
const RESULTS = ['hit', 'miss', 'bypass', 'error'] as const;

/** `cache_requests_total` of every worker, summed: cache → result → count. */
export type CacheRequests = Record<(typeof CACHES)[number], Record<(typeof RESULTS)[number], number>>;

/** One run's measurements, as the report lists them and the bar reads them. */
export interface RunMeasurement extends ArmRun {
  /** Its place in the schedule, from 1. */
  run: number;
  /** The `IHS_CACHES` the workers ran with. */
  ihsCaches: string;
  /** The simulator's run id, in the run's visit numbers and idempotency keys. */
  runId: string;
  /** The big-run judgement of the run, for information: the Cache run's bar doesn't read it. */
  verdict: Judgement['verdict'];
  /** The names of the big-run invariants that failed, for information. */
  failedInvariants: string[];
  /** Cases the run completed. */
  completedCases: number;
  /** Read calls (GET) the mock received. */
  upstreamReads: number;
  cacheRequests: CacheRequests;
  /** Hits over the requests that read the cache (hit, miss, error); null when none did. */
  hitRatio: Record<(typeof CACHES)[number], number | null>;
  /** First event accepted to last step completed, over the completed cases. */
  endToEndSeconds: { p50: number | null; p95: number | null };
  /** Every logged attempt's duration, start to end. */
  attemptSeconds: { p50: number | null; p95: number | null };
  /** From the last send until waiting ended. */
  drainSeconds: number;
  /** From the first send until waiting ended. */
  totalSeconds: number;
}

/** One run's measurements from its judgement, the mock's log, the cases and the workers' cache counters. */
export function measureRun(input: {
  run: number;
  scheduled: ScheduledRun;
  runId: string;
  judgement: Judgement;
  mockLog: readonly LogEntry[];
  cases: readonly CaseView[];
  cacheRequests: CacheRequests;
}): RunMeasurement {
  const { judgement, cases, cacheRequests } = input;
  const completedCases = cases.filter((c) => c.status === 'completed').length;
  const upstreamReads = input.mockLog.filter((e) => e.method === 'GET').length;
  const attempts = cases.flatMap((c) =>
    c.steps.flatMap((s) => s.attemptLog.flatMap((a) => (a.endedAt === null ? [] : [(Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000]))),
  );
  const hitRatio = (cache: (typeof CACHES)[number]) => {
    const { hit, miss, error } = cacheRequests[cache];
    return hit + miss + error === 0 ? null : hit / (hit + miss + error);
  };
  const { endToEndSeconds, durationsSeconds } = judgement.measurements;
  return {
    run: input.run,
    arm: input.scheduled.arm,
    ihsCaches: input.scheduled.ihsCaches,
    runId: input.runId,
    verdict: judgement.verdict,
    failedInvariants: judgement.invariants.filter((i) => !i.pass).map((i) => i.name),
    completedCases,
    upstreamReads,
    upstreamReadsPerCompletedCase: completedCases === 0 ? null : upstreamReads / completedCases,
    cacheRequests,
    hitRatio: { ihs_patient: hitRatio('ihs_patient'), ihs_practitioner: hitRatio('ihs_practitioner') },
    endToEndSeconds: { p50: endToEndSeconds.p50, p95: endToEndSeconds.p95 },
    endToEndP95Seconds: endToEndSeconds.p95,
    attemptSeconds: { p50: percentile(attempts, 0.5), p95: percentile(attempts, 0.95) },
    drainSeconds: durationsSeconds.drain,
    totalSeconds: durationsSeconds.total,
  };
}

/** Sums `cache_requests_total` over the Prometheus text expositions of every worker. */
export function cacheRequestsOf(expositions: readonly string[]): CacheRequests {
  const counts: CacheRequests = {
    ihs_patient: { hit: 0, miss: 0, bypass: 0, error: 0 },
    ihs_practitioner: { hit: 0, miss: 0, bypass: 0, error: 0 },
  };
  for (const line of expositions.flatMap((text) => text.split('\n'))) {
    const match = /^cache_requests_total\{(.*)\} (\S+)$/.exec(line);
    if (!match) continue;
    const labels = Object.fromEntries([...(match[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    const cache = CACHES.find((c) => c === labels.cache);
    const result = RESULTS.find((r) => r === labels.result);
    if (cache && result) counts[cache][result] += Number(match[2]);
  }
  return counts;
}
