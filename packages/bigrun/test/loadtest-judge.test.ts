import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeLoadTest } from '../src/loadtest/judge.js';
import { loadLoadTestSettings } from '../src/loadtest/settings.js';

const committed: unknown = JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'));
const { loadTest } = loadLoadTestSettings(committed, []);

/** A k6 2.x `handleSummary` payload, as the script writes it, for a measured phase with these numbers. */
function summary(load: { count: number; p95: number; p99: number; non2xx: number }, extra: Record<string, unknown> = {}) {
  return {
    root_group: {},
    options: {},
    state: { isStdOutTTY: false, isStdErrTTY: false, testRunDurationMs: 330_500 },
    metrics: {
      'http_req_duration{scenario:load}': {
        type: 'trend',
        contains: 'time',
        values: { count: load.count, min: 2, med: 20, avg: 25, 'p(90)': 60, 'p(95)': load.p95, 'p(99)': load.p99, max: 900 },
        thresholds: { 'p(95)<200': { ok: load.p95 < 200 }, 'p(99)<500': { ok: load.p99 < 500 } },
      },
      'ingest_non_2xx{scenario:load}': {
        type: 'rate',
        contains: 'default',
        values: { rate: load.non2xx / load.count, passes: load.non2xx, fails: load.count - load.non2xx },
        thresholds: { 'rate<0.001': { ok: load.non2xx / load.count < 0.001 } },
      },
      http_reqs: { type: 'counter', contains: 'default', values: { count: load.count + 6001, rate: 200 } },
      ingest_replayed: { type: 'counter', contains: 'default', values: { count: 13_000, rate: 39 } },
      vus_max: { type: 'gauge', contains: 'default', values: { value: 200, min: 200, max: 200 } },
      ...extra,
    },
  };
}

const failed = (j: ReturnType<typeof judgeLoadTest>) => j.checks.filter((c) => !c.pass).map((c) => c.name);

describe('judgeLoadTest', () => {
  it('passes when the measured phase is under every committed threshold and held the rate, and reports what it measured', () => {
    const judgement = judgeLoadTest(loadTest, 0, summary({ count: 60_001, p95: 120, p99: 310, non2xx: 30 }));
    expect(judgement.verdict).toBe('PASS');
    expect(judgement.checks.map((c) => [c.name, c.expected, c.actual, c.pass])).toEqual([
      ['Ingest p95, measured phase', '< 200 ms', '120 ms', true],
      ['Ingest p99, measured phase', '< 500 ms', '310 ms', true],
      ['Non-2xx rate, measured phase', '< 0.1%', '0.050% (30 of 60,001)', true],
      ['Requests sent, measured phase', '≥ 60,000 (200/s for 300s)', '60,001', true],
      ['k6 ended normally', 'exit code 0, or 99 for a crossed threshold', '0', true],
    ]);
    expect(judgement.measurements).toMatchObject({ requests: 60_001, requestsPerSecond: 200, droppedIterations: 0, replayed: 13_000, vusMax: 200 });
  });

  it('fails on a threshold reached exactly, since each is strictly less than', () => {
    expect(failed(judgeLoadTest(loadTest, 0, summary({ count: 60_000, p95: 200, p99: 499, non2xx: 60 })))).toEqual([
      'Ingest p95, measured phase',
      'Non-2xx rate, measured phase',
    ]);
  });

  it('fails a measured phase that sent fewer requests than its arrivals, dropped or failed, since it did not hold the committed rate', () => {
    const judgement = judgeLoadTest(loadTest, 0, summary({ count: 59_000, p95: 100, p99: 200, non2xx: 0 }, { dropped_iterations: { type: 'counter', contains: 'default', values: { count: 1001, rate: 3 } } }));
    expect(judgement.verdict).toBe('FAIL');
    expect(failed(judgement)).toEqual(['Requests sent, measured phase']);
    expect(judgement.measurements?.droppedIterations).toBe(1001);
  });

  it('passes a run whose only dropped arrivals were in the warm-up', () => {
    const judgement = judgeLoadTest(loadTest, 0, summary({ count: 60_000, p95: 100, p99: 200, non2xx: 0 }, { dropped_iterations: { type: 'counter', contains: 'default', values: { count: 40, rate: 1 } } }));
    expect(judgement.verdict).toBe('PASS');
  });

  it('fails a run whose k6 ended abnormally, even with a summary under every threshold; a crossed threshold (99) is an ordinary end', () => {
    expect(failed(judgeLoadTest(loadTest, 107, summary({ count: 60_001, p95: 100, p99: 200, non2xx: 0 })))).toEqual(['k6 ended normally']);
    expect(failed(judgeLoadTest(loadTest, 99, summary({ count: 60_001, p95: 300, p99: 200, non2xx: 0 })))).toEqual(['Ingest p95, measured phase']);
  });

  it('fails, naming why, when there is no summary or it lacks the measured phase', () => {
    for (const bad of [null, { metrics: {} }]) {
      const judgement = judgeLoadTest(loadTest, 0, bad);
      expect(judgement.verdict).toBe('FAIL');
      expect(judgement.measurements).toBeNull();
      expect(judgement.checks).toEqual([expect.objectContaining({ name: 'k6 summary readable', pass: false }), expect.objectContaining({ name: 'k6 ended normally', pass: true })]);
    }
  });
});
