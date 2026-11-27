// Judging a load test from k6's end-of-test summary: the committed thresholds
// on the measured phase, and whether k6 held the committed arrival rate.
import { z } from 'zod';
import type { LoadTestCommitments } from './settings.js';

/** One check of a load test, as the report's table shows it. */
export interface LoadTestCheck {
  /** What is checked, e.g. `Ingest p95, measured phase`. */
  name: string;
  /** The committed bar, as text. */
  expected: string;
  /** What the run showed, as text. */
  actual: string;
  /** Whether the run cleared the bar; the run passes only if every check does. */
  pass: boolean;
}

/** What the measured phase showed; information beside the checks. */
export interface LoadTestMeasurements {
  /** Requests the measured phase sent. */
  requests: number;
  /** Those requests over the phase's committed duration, to 0.1. */
  requestsPerSecond: number;
  /** Ingest latency (k6's `http_req_duration`) of the measured phase, client side. */
  latencyMs: { min: number; med: number; avg: number; p90: number; p95: number; p99: number; max: number };
  /** Answers outside 2xx in the measured phase, and their share of its requests. */
  non2xx: { count: number; rate: number };
  /** Arrivals k6 could not start, over both phases. */
  droppedIterations: number;
  /** Answers over both phases that carried `Idempotent-Replayed: true`. */
  replayed: number;
  /** The most VUs k6 had allocated at once, over both phases. */
  vusMax: number;
  /** How long k6 ran, warm-up included. */
  testRunSeconds: number;
}

/** A load test's verdict: PASS only if every check holds. */
export interface LoadTestJudgement {
  verdict: 'PASS' | 'FAIL';
  /** Every check, in the report's order. */
  checks: LoadTestCheck[];
  /** Null when the summary could not be read. */
  measurements: LoadTestMeasurements | null;
}

const counter = z.object({ values: z.object({ count: z.number() }) });
/** What the judge reads of a k6 `handleSummary` payload (k6 2.x). */
const summarySchema = z.object({
  state: z.object({ testRunDurationMs: z.number() }),
  metrics: z.object({
    'http_req_duration{scenario:load}': z.object({
      values: z.object({
        count: z.number().int().positive(),
        min: z.number(),
        med: z.number(),
        avg: z.number(),
        'p(90)': z.number(),
        'p(95)': z.number(),
        'p(99)': z.number(),
        max: z.number(),
      }),
    }),
    'ingest_non_2xx{scenario:load}': z.object({ values: z.object({ rate: z.number(), passes: z.number().int() }) }),
    // k6 leaves out a counter nothing was added to.
    dropped_iterations: counter.optional(),
    ingest_replayed: counter.optional(),
    vus_max: z.object({ values: z.object({ max: z.number() }) }),
  }),
});

const ms = (value: number) => `${Number(value.toFixed(1))} ms`;

/**
 * Judges a load test from k6's exit code and its summary (parsed here, at the
 * boundary): the measured phase's ingest p95 and p99 and its non-2xx rate,
 * each strictly under its committed threshold; a request sent for every
 * arrival of the measured phase, since a phase that dropped arrivals or whose
 * iterations failed did not hold the committed rate; and a k6 that ended
 * normally. A missing or unreadable summary is a FAIL naming why.
 */
export function judgeLoadTest(loadTest: LoadTestCommitments, k6ExitCode: number, summary: unknown): LoadTestJudgement {
  const ended: LoadTestCheck = {
    name: 'k6 ended normally',
    expected: 'exit code 0, or 99 for a crossed threshold',
    actual: String(k6ExitCode),
    pass: k6ExitCode === 0 || k6ExitCode === 99,
  };
  const parsed = summarySchema.safeParse(summary);
  if (!parsed.success) {
    const why = summary === null ? 'k6 wrote no summary' : parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { verdict: 'FAIL', checks: [{ name: 'k6 summary readable', expected: 'a k6 summary with the measured phase', actual: why, pass: false }, ended], measurements: null };
  }
  const { metrics, state } = parsed.data;
  const latency = metrics['http_req_duration{scenario:load}'].values;
  const non2xx = metrics['ingest_non_2xx{scenario:load}'].values;
  const dropped = metrics.dropped_iterations?.values.count ?? 0;
  const { thresholds } = loadTest;
  const arrivals = loadTest.eventsPerSecond * loadTest.durationSeconds;
  const checks: LoadTestCheck[] = [
    { name: 'Ingest p95, measured phase', expected: `< ${thresholds.ingestP95Ms} ms`, actual: ms(latency['p(95)']), pass: latency['p(95)'] < thresholds.ingestP95Ms },
    { name: 'Ingest p99, measured phase', expected: `< ${thresholds.ingestP99Ms} ms`, actual: ms(latency['p(99)']), pass: latency['p(99)'] < thresholds.ingestP99Ms },
    {
      name: 'Non-2xx rate, measured phase',
      expected: `< ${Number((thresholds.non2xxRate * 100).toFixed(6))}%`,
      actual: `${(non2xx.rate * 100).toFixed(3)}% (${non2xx.passes.toLocaleString('en-US')} of ${latency.count.toLocaleString('en-US')})`,
      pass: non2xx.rate < thresholds.non2xxRate,
    },
    {
      name: 'Requests sent, measured phase',
      expected: `≥ ${arrivals.toLocaleString('en-US')} (${loadTest.eventsPerSecond}/s for ${loadTest.durationSeconds}s)`,
      actual: latency.count.toLocaleString('en-US'),
      pass: latency.count >= arrivals,
    },
    ended,
  ];
  return {
    verdict: checks.every((c) => c.pass) ? 'PASS' : 'FAIL',
    checks,
    measurements: {
      requests: latency.count,
      requestsPerSecond: Math.round((latency.count / loadTest.durationSeconds) * 10) / 10,
      latencyMs: { min: latency.min, med: latency.med, avg: latency.avg, p90: latency['p(90)'], p95: latency['p(95)'], p99: latency['p(99)'], max: latency.max },
      non2xx: { count: non2xx.passes, rate: non2xx.rate },
      droppedIterations: dropped,
      replayed: metrics.ingest_replayed?.values.count ?? 0,
      vusMax: metrics.vus_max.values.max,
      testRunSeconds: state.testRunDurationMs / 1000,
    },
  };
}
