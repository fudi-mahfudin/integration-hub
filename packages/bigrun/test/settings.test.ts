import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSettings, SettingsError } from '../src/settings.js';

const committed: unknown = JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'));
/** A fresh copy of the committed file to edit, as plain JSON. */
const editable = (): { bigRun: Record<string, Record<string, unknown>> } => JSON.parse(JSON.stringify(committed));

describe('loadSettings', () => {
  it('runs the committed big run unchanged, as an unofficial run without flags', () => {
    const settings = loadSettings(committed, []);
    expect(settings.kind).toBe('unofficial');
    expect(settings.overrides).toEqual([]);
    expect(settings.bigRun.seed).toBe(20261125);
    expect(settings.bigRun.events).toMatchObject({ visits: 2000, uniqueEvents: 8000, duplicates: 2000, total: 10000 });
  });

  it('makes a run official only with --official', () => {
    expect(loadSettings(committed, ['--official']).kind).toBe('official');
  });

  it('applies a --set override at a path, records it, and keeps the run unofficial', () => {
    const settings = loadSettings(committed, ['--set', 'arrival.eventsPerSecond=25']);
    expect(settings.bigRun.arrival.eventsPerSecond).toBe(25);
    expect(settings.overrides).toEqual([{ path: 'arrival.eventsPerSecond', value: 25 }]);
    expect(settings.kind).toBe('unofficial');
  });

  it('refuses --official together with --set or --ci', () => {
    expect(() => loadSettings(committed, ['--official', '--set', 'arrival.eventsPerSecond=25'])).toThrow(/--official.*--set/);
    expect(() => loadSettings(committed, ['--official', '--ci'])).toThrow(SettingsError);
  });

  it('refuses a --set path the commitments do not have, or one without a value', () => {
    expect(() => loadSettings(committed, ['--set', 'arrival.speed=25'])).toThrow(/arrival\.speed/);
    expect(() => loadSettings(committed, ['--set', 'arrival.eventsPerSecond'])).toThrow(/path=value/);
    expect(() => loadSettings(committed, ['--fast'])).toThrow(/--fast/);
  });

  it('scales the run down to 200 visits for CI, keeping the ratios, faults and deadlines', () => {
    const full = loadSettings(committed, []).bigRun;
    const ci = loadSettings(committed, ['--ci']);
    expect(ci.kind).toBe('ci');
    expect(ci.bigRun.events).toMatchObject({ visits: 200, uniqueEvents: 800, duplicates: 200, total: 1000 });
    expect(ci.bigRun.invariants.hubSide).toMatchObject({ completedCases: 200, completedSteps: 800 });
    expect(ci.bigRun.duplicateTiming).toEqual(full.duplicateTiming);
    expect(ci.bigRun.eventMix).toEqual(full.eventMix);
    expect(ci.bigRun.faults).toEqual(full.faults);
    expect(ci.bigRun.completion).toEqual(full.completion);
  });

  it('refuses commitments whose counts do not add up', () => {
    const wrongTotal = editable();
    wrongTotal.bigRun.events = { ...wrongTotal.bigRun.events, total: 9999 };
    expect(() => loadSettings(wrongTotal, [])).toThrow(/total/);

    const wrongWeights = editable();
    const reads = (wrongWeights.bigRun.faults as { reads: { weights: Record<string, number> } }).reads;
    reads.weights.http_500 = 7;
    expect(() => loadSettings(wrongWeights, [])).toThrow(/reads/);

    const wrongCases = editable();
    wrongCases.bigRun.invariants = { ...wrongCases.bigRun.invariants, hubSide: { completedCases: 1999, waitingCases: 0, deadLetteredCases: 0, abandonedCases: 0, completedSteps: 8000 } };
    expect(() => loadSettings(wrongCases, [])).toThrow(/completedCases/);
  });
});
