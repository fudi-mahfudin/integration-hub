import { readFileSync } from 'node:fs';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { eventFile, planBatch } from '@integration-hub/simulator';
import { describe, expect, it } from 'vitest';
import { loadLoadTestSettings, loadTestBatch, loadTestRequests } from '../src/loadtest/settings.js';
import { loadSettings, SettingsError } from '../src/settings.js';

const committed: unknown = JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'));

describe('loadLoadTestSettings', () => {
  it('runs the committed load test, official only with --official', () => {
    const settings = loadLoadTestSettings(committed, ['--official']);
    expect(settings.kind).toBe('official');
    expect(settings.overrides).toEqual([]);
    expect(settings.loadTest).toMatchObject({
      eventsPerSecond: 200,
      durationSeconds: 300,
      warmUpSeconds: 30,
      duplicateShare: 0.2,
      thresholds: { ingestP95Ms: 200, ingestP99Ms: 500, non2xxRate: 0.001 },
    });
    expect(loadLoadTestSettings(committed, []).kind).toBe('unofficial');
  });

  it('applies and records a --set override under loadTest, and refuses one combined with --official or at a path loadTest lacks', () => {
    const settings = loadLoadTestSettings(committed, ['--set', 'durationSeconds=20']);
    expect(settings.loadTest.durationSeconds).toBe(20);
    expect(settings.overrides).toEqual([{ path: 'durationSeconds', value: 20 }]);
    expect(settings.kind).toBe('unofficial');
    expect(() => loadLoadTestSettings(committed, ['--official', '--set', 'durationSeconds=20'])).toThrow(SettingsError);
    expect(() => loadLoadTestSettings(committed, ['--set', 'rampSeconds=5'])).toThrow(/loadTest has no "rampSeconds"/);
    expect(() => loadLoadTestSettings(committed, ['--ci'])).toThrow(/unknown argument "--ci"/);
  });
});

describe('loadTestBatch', () => {
  it('plans an event file with one request per arrival of the warm-up and the measured phase, a fifth of them duplicates, in the big run mix', async () => {
    const { bigRun } = loadSettings(committed, []);
    const { loadTest } = loadLoadTestSettings(committed, ['--set', 'warmUpSeconds=5', '--set', 'durationSeconds=20']);
    const batch = loadTestBatch(bigRun, loadTest, 'LT1');

    expect(batch).toMatchObject({
      seed: 20261125,
      runId: 'LT1',
      outOfOrder: { share: 0.1, delayMs: 2000 },
      substitutionShare: 0.1,
      fallbackLookupShare: 0.1,
      duplicates: { concurrent: 0.5, delayed: 0.3, late: 0.2, delayedWindowMs: { min: 500, max: 10_000 } },
    });
    const lines = eventFile(planBatch(await loadWorld(DEFAULT_WORLD_PATH), batch));
    // k6 starts an arrival at both ends of a phase: 200 × 5 + 1, then 200 × 20 + 1.
    expect(loadTestRequests(loadTest)).toEqual({ warmUp: 1001, load: 4001 });
    expect(lines).toHaveLength(5005);
    expect(lines.filter((l) => l.duplicate)).toHaveLength(1001);
  });

  it('sizes the committed load test at 13,201 visits for 66,002 arrivals, and a zero-second warm-up at none', () => {
    const { bigRun } = loadSettings(committed, []);
    const { loadTest } = loadLoadTestSettings(committed, []);
    expect(loadTestRequests(loadTest)).toEqual({ warmUp: 6001, load: 60_001 });
    expect(loadTestBatch(bigRun, loadTest, 'LT2').visits).toBe(13_201);
    expect(loadTestRequests(loadLoadTestSettings(committed, ['--set', 'warmUpSeconds=0']).loadTest)).toEqual({ warmUp: 0, load: 60_001 });
  });
});
