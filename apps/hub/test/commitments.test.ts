import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Expected values are the literals decided in #19 (big run, load test) and
// #20 (cache run), not recomputed from the file.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const commitments = JSON.parse(
  readFileSync(`${repoRoot}bigrun.commitments.json`, 'utf8'),
);
const readme = readFileSync(`${repoRoot}README.md`, 'utf8');

const sum = (weights: Record<string, number>) =>
  Object.values(weights).reduce((a, b) => a + b, 0);

describe('bigrun.commitments.json: big run', () => {
  const big = commitments.bigRun;

  it('sends 2,000 visits x 4 events plus 2,000 duplicates = 10,000 events', () => {
    expect(big.events).toMatchObject({
      visits: 2000,
      eventsPerVisit: 4,
      duplicates: 2000,
      total: 10000,
    });
    expect(
      big.events.visits * big.events.eventsPerVisit + big.events.duplicates,
    ).toBe(big.events.total);
  });

  it('times duplicates 50/30/20 concurrent/delayed/late', () => {
    expect(big.duplicateTimingPercent).toEqual({
      concurrent: 50,
      delayed: 30,
      late: 20,
    });
  });

  it('fixes ~10% out of order, substitution and fallback person lookup', () => {
    expect(big.eventMixPercent).toEqual({
      outOfOrder: 10,
      substitution: 10,
      fallbackPersonLookup: 10,
    });
  });

  it('commits read and write fault groups at 30% each with the #19 weights', () => {
    const { read, write } = big.faults;
    expect(read.weights).toEqual({
      http_500: 6,
      http_503: 6,
      http_429: 6,
      timeout: 6,
      connection_reset: 6,
    });
    expect(write.weights).toEqual({
      timeout_after_apply: 7,
      http_500_after_apply: 7,
      http_500: 4,
      http_503: 4,
      http_429: 4,
      timeout: 2,
      connection_reset: 2,
    });
    expect(read.totalPercent).toBe(30);
    expect(write.totalPercent).toBe(30);
    expect(sum(read.weights)).toBe(30);
    expect(sum(write.weights)).toBe(30);
  });

  it('commits an integer seed', () => {
    expect(Number.isInteger(big.seed)).toBe(true);
  });

  it('runs open loop at 50 events/s on 1 hub + 2 workers with pinned limits', () => {
    expect(big.rate).toEqual({ eventsPerSecond: 50, loop: 'open' });
    expect(big.topology.hubServices).toBe(1);
    expect(big.topology.workers).toBe(2);
    for (const limit of Object.values(big.topology.composeLimits) as {
      cpus: number;
      memory: string;
    }[]) {
      expect(limit.cpus).toBeGreaterThan(0);
      expect(limit.memory).toMatch(/^\d+[mg]$/);
    }
    expect(Object.keys(big.topology.composeLimits)).toEqual(
      expect.arrayContaining(['hub', 'worker', 'postgres', 'redis', 'mock']),
    );
  });

  it('fails fast after 10 min without progress, hard deadline 60 min', () => {
    expect(big.deadlines).toEqual({
      noProgressFailFastMinutes: 10,
      hardDeadlineMinutes: 60,
    });
  });

  it('passes only on the five invariants', () => {
    expect(big.invariants).toEqual({
      lostEvents: 0,
      duplicateSubmissions: 0,
      orderPreservedPerCase: true,
      deadLetteredCases: 0,
      abandonedCases: 0,
    });
  });
});

describe('bigrun.commitments.json: load test', () => {
  it('runs 200 events/s for 5 min after 30s warm-up, no faults, with fixed thresholds', () => {
    expect(commitments.loadTest).toEqual({
      tool: 'k6',
      executor: 'constant-arrival-rate',
      eventsPerSecond: 200,
      durationSeconds: 300,
      warmUpSeconds: 30,
      faults: false,
      duplicatePercent: 20,
      thresholds: { p95Ms: 200, p99Ms: 500, non2xxPercent: 0.1 },
    });
  });
});

describe('bigrun.commitments.json: cache run', () => {
  const cache = commitments.cacheRun;

  it('runs faults off with 150ms reads / 300ms writes', () => {
    expect(cache.faults).toBe(false);
    expect(cache.mockLatencyMs).toEqual({ read: 150, write: 300 });
  });

  it('alternates three arms x 3 runs', () => {
    expect(cache.arms).toEqual(['off', 'practitioner_only', 'both']);
    expect(cache.runsPerArm).toBe(3);
    expect(cache.order).toBe('alternating');
  });

  it('keeps a cache only if it clears the bar', () => {
    expect(cache.barToStay).toEqual({
      upstreamReadsPerCompletedCaseReductionPercentMin: 20,
      e2eP95ImprovementPercentMin: 10,
      e2eP95ImprovementMustExceedArmSpread: true,
      officialBigRunPassesWithCacheOn: true,
    });
  });
});

describe('bigrun.commitments.json: world dataset', () => {
  it('has 1,000 patients drawn uniformly and 30 practitioners', () => {
    expect(commitments.worldDataset).toEqual({
      patients: 1000,
      patientDraw: 'uniform',
      practitioners: 30,
    });
  });
});

describe('README', () => {
  it('links every ADR in docs/adr', () => {
    const adrs = readdirSync(`${repoRoot}docs/adr`).filter((f) =>
      /^\d{4}-.*\.md$/.test(f),
    );
    expect(adrs.length).toBeGreaterThanOrEqual(7);
    for (const adr of adrs) expect(readme).toContain(`docs/adr/${adr}`);
  });

  it('links the history of the commitments file', () => {
    expect(readme).toContain(
      'https://github.com/fudi-mahfudin/integration-hub/commits/main/bigrun.commitments.json',
    );
  });
});
