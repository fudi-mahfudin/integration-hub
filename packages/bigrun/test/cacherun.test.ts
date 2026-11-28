import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgeCaches, type ArmRun } from '../src/cacherun/judge.js';
import { cacheRequestsOf } from '../src/cacherun/measure.js';
import { loadCacheRunSettings, removedCacheRefusals } from '../src/cacherun/settings.js';
import { SettingsError } from '../src/settings.js';

const committed: unknown = JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'));

describe('loadCacheRunSettings', () => {
  it('runs the committed three arms three times each, alternating, against the committed big run', () => {
    const settings = loadCacheRunSettings(committed, ['--official']);

    expect(settings.kind).toBe('official');
    expect(settings.bigRun.events.visits).toBe(2000);
    expect(settings.cacheRun.mockLatencyMs).toEqual({ reads: 150, writes: 300 });
    expect(settings.schedule.map((run) => run.arm)).toEqual([
      'no cache',
      'ihs_practitioner only',
      'ihs_patient + ihs_practitioner',
      'no cache',
      'ihs_practitioner only',
      'ihs_patient + ihs_practitioner',
      'no cache',
      'ihs_practitioner only',
      'ihs_patient + ihs_practitioner',
    ]);
    expect(settings.schedule.slice(0, 3).map((run) => run.ihsCaches)).toEqual(['none', 'ihs_practitioner', 'ihs_patient,ihs_practitioner']);
  });

  it('refuses, before any run, a schedule with an arm whose cache the hub no longer has, naming the run that removed it', () => {
    const { schedule } = loadCacheRunSettings(committed, ['--ci', '--set', 'runsPerArm=1']);

    expect(removedCacheRefusals(schedule)).toEqual([
      'the arm "ihs_patient + ihs_practitioner" needs ihs_patient, which the hub no longer has: it missed the bar in results/cache/2026-11-28-d0550b0. The committed Cache run reruns only at d0550b0.',
    ]);
    expect(removedCacheRefusals(schedule.filter((run) => run.arm !== 'ihs_patient + ihs_practitioner'))).toEqual([]);
  });

  it('scales the big run to the CI visits with --ci, and takes --set overrides under cacheRun; neither is official', () => {
    const settings = loadCacheRunSettings(committed, ['--ci', '--set', 'runsPerArm=1']);

    expect(settings.kind).toBe('unofficial');
    expect(settings.bigRun.events).toMatchObject({ visits: 200, uniqueEvents: 800 });
    expect(settings.schedule).toHaveLength(3);
    expect(settings.overrides).toEqual([{ path: 'runsPerArm', value: 1 }]);
  });

  it('refuses --official with anything that changes the run, and an unknown flag', () => {
    expect(() => loadCacheRunSettings(committed, ['--official', '--ci'])).toThrow(SettingsError);
    expect(() => loadCacheRunSettings(committed, ['--official', '--set', 'runsPerArm=1'])).toThrow(/--official/);
    expect(() => loadCacheRunSettings(committed, ['--fast'])).toThrow(/--fast/);
  });
});

describe('judgeCaches: each cache against the arm without it', () => {
  const bar = { upstreamReadsPerCompletedCaseReduction: 0.2, medianE2eCaseP95Improvement: 0.1, e2eImprovementMustExceedArmSpread: true, officialBigRunPassesWithCacheOn: true } as const;
  const runs = (arm: ArmRun['arm'], readsPerCase: number, p95s: number[]): ArmRun[] =>
    p95s.map((p95) => ({ arm, upstreamReadsPerCompletedCase: readsPerCase, endToEndP95Seconds: p95 }));

  it('keeps a cache that cuts reads by 20% and the median p95 by 10% and by more than either arm’s spread', () => {
    const [practitioner] = judgeCaches([...runs('no cache', 20, [100, 102, 98]), ...runs('ihs_practitioner only', 15, [85, 86, 84])], bar);

    expect(practitioner).toMatchObject({
      cache: 'ihs_practitioner',
      against: 'no cache',
      upstreamReads: { reduction: 0.25, pass: true },
      endToEndP95: { medianWithoutSeconds: 100, medianWithSeconds: 85, improvement: 0.15, spreadSeconds: 4, pass: true },
      measuredBarsPass: true,
    });
  });

  it('removes a cache that cuts reads by less than 20%', () => {
    const decisions = judgeCaches(
      [...runs('no cache', 20, [100, 100, 100]), ...runs('ihs_practitioner only', 15, [85, 85, 85]), ...runs('ihs_patient + ihs_practitioner', 14, [70, 70, 70])],
      bar,
    );

    expect(decisions.find((d) => d.cache === 'ihs_patient')).toMatchObject({
      against: 'ihs_practitioner only',
      upstreamReads: { pass: false },
      endToEndP95: { pass: true },
      measuredBarsPass: false,
    });
  });

  it('removes a cache whose p95 improvement is 10% but within the spread of the runs', () => {
    const [practitioner] = judgeCaches([...runs('no cache', 20, [100, 80, 120]), ...runs('ihs_practitioner only', 10, [85, 86, 84])], bar);

    expect(practitioner).toMatchObject({ endToEndP95: { improvement: 0.15, spreadSeconds: 40, pass: false }, measuredBarsPass: false });
  });

  it('judges no reduction when a run of either arm completed no case', () => {
    const decisions = judgeCaches(
      [
        ...runs('no cache', 20, [100, 100]),
        { arm: 'no cache', upstreamReadsPerCompletedCase: null, endToEndP95Seconds: null },
        ...runs('ihs_practitioner only', 10, [50, 50, 50]),
      ],
      bar,
    );

    expect(decisions[0]).toMatchObject({ upstreamReads: { reduction: null, pass: false }, endToEndP95: { improvement: null, pass: false }, measuredBarsPass: false });
  });

  it('removes a cache whose p95 improves by less than 10%', () => {
    const [practitioner] = judgeCaches([...runs('no cache', 20, [100, 100, 100]), ...runs('ihs_practitioner only', 10, [95, 95, 95])], bar);

    expect(practitioner).toMatchObject({ endToEndP95: { improvement: 0.05, pass: false }, measuredBarsPass: false });
  });
});

describe('cacheRequestsOf', () => {
  it("sums every worker's cache_requests_total by cache and result", () => {
    const worker = (hits: number) =>
      [
        '# HELP cache_requests_total Cache requests by cache and result.',
        '# TYPE cache_requests_total counter',
        `cache_requests_total{cache="ihs_patient",result="hit"} ${hits}`,
        'cache_requests_total{cache="ihs_patient",result="miss"} 3',
        'cache_requests_total{cache="ihs_practitioner",result="error"} 1',
        'step_attempts_total{step="create_visit",outcome="success"} 9',
      ].join('\n');

    expect(cacheRequestsOf([worker(5), worker(7)])).toEqual({
      ihs_patient: { hit: 12, miss: 6, bypass: 0, error: 0 },
      ihs_practitioner: { hit: 0, miss: 0, bypass: 0, error: 2 },
    });
  });
});
