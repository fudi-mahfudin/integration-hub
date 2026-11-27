// What k6 is run with: its options, built from the committed load test so the
// script (k6/ingest.js) holds no number of its own.
import type { LoadTestCommitments } from './settings.js';

/** One constant-arrival-rate scenario of the k6 options. */
export interface ArrivalScenario {
  executor: 'constant-arrival-rate';
  /** The function of k6/ingest.js each iteration runs. */
  exec: 'ingest';
  rate: number;
  timeUnit: '1s';
  duration: string;
  startTime: string;
  preAllocatedVUs: number;
  maxVUs: number;
}

/** The k6 options a load test runs with: `export const options` of k6/ingest.js. */
export interface K6Options {
  /** `warmup` (absent for a zero-second warm-up) then `load`, the measured phase every threshold is on. */
  scenarios: { warmup?: ArrivalScenario; load: ArrivalScenario };
  thresholds: Record<string, string[]>;
  summaryTrendStats: string[];
}

/**
 * The k6 options for a load test: a warm-up then the measured phase, each at
 * the committed arrival rate, with the committed thresholds on the measured
 * phase only. `ingest_non_2xx` is the script's own rate of answers outside
 * 2xx (k6's `http_req_failed` counts 3xx as passed).
 */
export function k6Options(loadTest: LoadTestCommitments): K6Options {
  const scenario = (startSeconds: number, durationSeconds: number): ArrivalScenario => ({
    executor: 'constant-arrival-rate',
    exec: 'ingest',
    rate: loadTest.eventsPerSecond,
    timeUnit: '1s',
    duration: `${durationSeconds}s`,
    startTime: `${startSeconds}s`,
    // A VU per arrival per second covers answers up to 1s, and k6 may start up to five times that before it drops arrivals.
    preAllocatedVUs: loadTest.eventsPerSecond,
    maxVUs: loadTest.eventsPerSecond * 5,
  });
  const { thresholds } = loadTest;
  return {
    scenarios: {
      ...(loadTest.warmUpSeconds > 0 ? { warmup: scenario(0, loadTest.warmUpSeconds) } : {}),
      load: scenario(loadTest.warmUpSeconds, loadTest.durationSeconds),
    },
    thresholds: {
      'http_req_duration{scenario:load}': [`p(95)<${thresholds.ingestP95Ms}`, `p(99)<${thresholds.ingestP99Ms}`],
      'ingest_non_2xx{scenario:load}': [`rate<${thresholds.non2xxRate}`],
    },
    summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  };
}
