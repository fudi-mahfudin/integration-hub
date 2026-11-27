// The measurements only Prometheus has, queried over the run's window. They
// are information, never pass criteria: a query that fails is reported as
// such and changes no verdict.
import { z } from 'zod';

const vectorResponse = z.object({
  status: z.literal('success'),
  data: z.object({ result: z.array(z.object({ metric: z.record(z.string(), z.string()), value: z.tuple([z.number(), z.string()]) })) }),
});

/** What Prometheus measured over a run. A null value is one Prometheus had no data for. */
export interface PrometheusMeasurements {
  windowSeconds: number;
  completedStepsPerSecond: number | null;
  /** Server-side ingest latency, a cross-check of the client-side figures. */
  ingestServerMs: { p50: number | null; p95: number | null; p99: number | null };
  outboxLagSeconds: { max: number | null; p95: number | null };
  breakerOpens: Record<string, number>;
  limiterWaitP95Seconds: number | null;
  /** Queries that failed, with why. */
  errors: string[];
}

/** Queries the measurements for the window that ended at `end` and lasted `windowSeconds`. */
export async function queryPrometheus(baseUrl: URL, end: Date, windowSeconds: number): Promise<PrometheusMeasurements> {
  const errors: string[] = [];
  const range = `${Math.max(1, Math.ceil(windowSeconds))}s`;
  const query = async (promql: string) => {
    const url = new URL('api/v1/query', baseUrl);
    url.searchParams.set('query', promql);
    url.searchParams.set('time', String(end.getTime() / 1000));
    try {
      const res = await fetch(url);
      return vectorResponse.parse(await res.json()).data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
    } catch (err) {
      // Carrying on is safe: these measurements are information only, and the error is reported.
      errors.push(`${promql}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };
  const scalar = async (promql: string) => {
    const value = (await query(promql))[0]?.value;
    return value === undefined || !Number.isFinite(value) ? null : value;
  };
  const quantileMs = async (q: number) => {
    const seconds = await scalar(`histogram_quantile(${q}, sum by (le) (increase(ingest_request_duration_seconds_bucket[${range}])))`);
    return seconds === null ? null : seconds * 1000;
  };
  const opens = await query(`sum by (upstream) (increase(circuit_breaker_opens_total[${range}]))`);
  return {
    windowSeconds,
    completedStepsPerSecond: await scalar(`sum(increase(steps_completed_total[${range}])) / ${Math.max(1, windowSeconds)}`),
    ingestServerMs: { p50: await quantileMs(0.5), p95: await quantileMs(0.95), p99: await quantileMs(0.99) },
    outboxLagSeconds: {
      max: await scalar(`max_over_time(max(outbox_lag_seconds)[${range}:5s])`),
      p95: await scalar(`quantile_over_time(0.95, max(outbox_lag_seconds)[${range}:5s])`),
    },
    breakerOpens: Object.fromEntries(opens.map((r) => [r.labels.upstream ?? 'unknown', Math.round(r.value)])),
    limiterWaitP95Seconds: await scalar(`histogram_quantile(0.95, sum by (le) (increase(rate_limiter_wait_seconds_bucket[${range}])))`),
    errors,
  };
}
