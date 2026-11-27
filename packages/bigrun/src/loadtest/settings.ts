// What a load test is run with: the committed `loadTest` section of
// bigrun.commitments.json, and the command line that may override it. Only an
// unmodified run may be official.
import type { BatchOptions } from '@integration-hub/simulator';
import { z } from 'zod';
import { parseOverride, SettingsError, withValueAt, type BigRunCommitments, type Override } from '../settings.js';

const loadTestSchema = z.object({
  tool: z.literal('k6'),
  executor: z.literal('constant-arrival-rate'),
  eventsPerSecond: z.number().int().positive(),
  durationSeconds: z.number().int().positive(),
  warmUpSeconds: z.number().int().min(0),
  faults: z.literal('none'),
  duplicateShare: z.number().min(0).lt(1),
  thresholds: z.object({ ingestP95Ms: z.number().positive(), ingestP99Ms: z.number().positive(), non2xxRate: z.number().min(0).max(1) }),
});

/** The committed load test: the arrival rate, phases, event mix share and thresholds it runs and is judged by. */
export type LoadTestCommitments = z.infer<typeof loadTestSchema>;

/** What kind of load test this is. `official`: the committed one, unmodified, from a clean tree; only these are published. */
export type LoadTestKind = 'official' | 'unofficial';

/** What one load test is run with. */
export interface LoadTestSettings {
  kind: LoadTestKind;
  /** The commitments after any overrides. */
  loadTest: LoadTestCommitments;
  /** Every override, flagged in the report. */
  overrides: Override[];
}

/**
 * Reads the `loadTest` section of the parsed commitments file and applies the
 * command line: `--official`, and any number of `--set path=value` under
 * `loadTest`. Throws {@link SettingsError} for an unknown flag, `--official`
 * with an override, or an override of a path the section doesn't have.
 */
export function loadLoadTestSettings(commitments: unknown, argv: readonly string[]): LoadTestSettings {
  let official = false;
  const sets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--official') official = true;
    else if (arg === '--set') {
      const value = argv[++i];
      if (value === undefined) throw new SettingsError('--set needs path=value after it');
      sets.push(value);
    } else throw new SettingsError(`unknown argument "${arg}": expected --official or --set path=value`);
  }
  if (official && sets.length > 0) throw new SettingsError("--official runs the committed load test unchanged, so it can't be combined with --set");

  const root = z.object({ loadTest: z.record(z.string(), z.unknown()) }).safeParse(commitments);
  if (!root.success) throw new SettingsError('the commitments file must hold a "loadTest" object');
  let raw: unknown = structuredClone(root.data.loadTest);
  const overrides = sets.map((set) => {
    const override = parseOverride(set);
    raw = withValueAt(raw, override, 'loadTest');
    return override;
  });
  const parsed = loadTestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `loadTest.${i.path.join('.')}: ${i.message}`);
    throw new SettingsError(`the commitments don't match what the load test runs: ${issues.join('; ')}`);
  }
  return { kind: official ? 'official' : 'unofficial', loadTest: parsed.data, overrides };
}

/**
 * How many arrivals each phase can have, so how many requests of the event
 * file it may send: k6's constant-arrival-rate starts one at both ends of a
 * phase, so `rate × seconds + 1`. The measured phase starts after the
 * warm-up's share of the file, so no request is sent by both.
 */
export function loadTestRequests(loadTest: LoadTestCommitments): { warmUp: number; load: number } {
  const arrivals = (seconds: number) => (seconds === 0 ? 0 : loadTest.eventsPerSecond * seconds + 1);
  return { warmUp: arrivals(loadTest.warmUpSeconds), load: arrivals(loadTest.durationSeconds) };
}

/**
 * The simulator batch the event file is planned from: the big run's seed,
 * event mix and duplicate timings, with enough visits that the file holds a
 * request for every arrival ({@link loadTestRequests}), `duplicateShare` of them duplicates.
 */
export function loadTestBatch(bigRun: BigRunCommitments, loadTest: LoadTestCommitments, runId: string): BatchOptions {
  const originalShare = 1 - loadTest.duplicateShare;
  const { duplicateTiming, eventMix } = bigRun;
  const requests = loadTestRequests(loadTest);
  return {
    seed: bigRun.seed,
    runId,
    visits: Math.ceil((requests.warmUp + requests.load) * originalShare / bigRun.events.eventsPerVisit),
    // Only the order of the file matters to a replay at a fixed rate; this keeps the planned times near the replayed ones.
    eventsPerSecond: loadTest.eventsPerSecond * originalShare,
    outOfOrder: { share: eventMix.outOfOrder, delayMs: eventMix.outOfOrderHoldSeconds * 1000 },
    substitutionShare: eventMix.substitution,
    fallbackLookupShare: eventMix.fallbackPersonLookup,
    duplicates: {
      perEvent: loadTest.duplicateShare / originalShare,
      concurrent: duplicateTiming.concurrent,
      delayed: duplicateTiming.delayed,
      late: duplicateTiming.late,
      delayedWindowMs: { min: duplicateTiming.delayedWindowSeconds.min * 1000, max: duplicateTiming.delayedWindowSeconds.max * 1000 },
    },
  };
}
