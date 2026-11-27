// What a Cache run is run with: the committed `cacheRun` section of
// bigrun.commitments.json, the committed big run it runs on, and the command
// line that may scale it down or override it. Only an unmodified run may be official.
import { z } from 'zod';
import { loadSettings, parseOverride, SettingsError, withValueAt, type BigRunCommitments, type Override } from '../settings.js';

/** The three arms, in the committed order; each turns on the caches it names (#20). */
export const ARMS = ['no cache', 'ihs_practitioner only', 'ihs_patient + ihs_practitioner'] as const;

/** One arm of the Cache run. */
export type ArmName = (typeof ARMS)[number];

/** Each arm's `IHS_CACHES`, as the workers read it. */
const IHS_CACHES_OF: Record<ArmName, string> = {
  'no cache': 'none',
  'ihs_practitioner only': 'ihs_practitioner',
  'ihs_patient + ihs_practitioner': 'ihs_patient,ihs_practitioner',
};

const share = z.number().min(0).max(1);

const cacheRunSchema = z.object({
  faults: z.literal('none'),
  eventsPerSecond: z.number().positive(),
  topology: z.literal('same as bigRun'),
  mockLatencyMs: z.object({ reads: z.number().int().min(0), writes: z.number().int().min(0) }),
  arms: z.tuple([z.literal(ARMS[0]), z.literal(ARMS[1]), z.literal(ARMS[2])]),
  runsPerArm: z.number().int().min(1),
  order: z.literal('alternating'),
  barToStay: z.object({
    upstreamReadsPerCompletedCaseReduction: share,
    medianE2eCaseP95Improvement: share,
    e2eImprovementMustExceedArmSpread: z.literal(true),
    officialBigRunPassesWithCacheOn: z.literal(true),
  }),
});

/** The committed Cache run: its arms, how often and in which order they run, the mock's latency, and the bar a cache must clear. */
export type CacheRunCommitments = z.infer<typeof cacheRunSchema>;

/** One run of the schedule: its arm, and the `IHS_CACHES` the workers run it with. */
export interface ScheduledRun {
  arm: ArmName;
  ihsCaches: string;
}

/** What one Cache run is run with. */
export interface CacheRunSettings {
  /** `official`: the committed run, unmodified, from a clean tree; only these are published. */
  kind: 'official' | 'unofficial';
  /** The committed big run: event mix, topology, seed and deadlines; its faults are not set. */
  bigRun: BigRunCommitments;
  cacheRun: CacheRunCommitments;
  /** The runs in order: every arm in turn, `runsPerArm` times. */
  schedule: ScheduledRun[];
  /** Every `--set` override under `cacheRun`, flagged in the report. */
  overrides: Override[];
}

/**
 * Reads the `cacheRun` and `bigRun` sections of the parsed commitments file
 * and applies the command line: `--official`; `--ci`, which runs the big run
 * at the committed CI visits; and any number of `--set path=value` under
 * `cacheRun`. Throws {@link SettingsError} for an unknown flag, `--official`
 * with anything that changes the run, or an override of a path the section doesn't have.
 */
export function loadCacheRunSettings(commitments: unknown, argv: readonly string[]): CacheRunSettings {
  let official = false;
  let ci = false;
  const sets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--official') official = true;
    else if (arg === '--ci') ci = true;
    else if (arg === '--set') {
      const value = argv[++i];
      if (value === undefined) throw new SettingsError('--set needs path=value after it');
      sets.push(value);
    } else throw new SettingsError(`unknown argument "${arg}": expected --official, --ci or --set path=value`);
  }
  if (official && (ci || sets.length > 0)) {
    throw new SettingsError(`--official runs the committed Cache run unchanged, so it can't be combined with ${ci ? '--ci' : '--set'}`);
  }

  const root = z.object({ cacheRun: z.record(z.string(), z.unknown()) }).safeParse(commitments);
  if (!root.success) throw new SettingsError('the commitments file must hold a "cacheRun" object');
  let raw: unknown = structuredClone(root.data.cacheRun);
  const overrides = sets.map((set) => {
    const override = parseOverride(set);
    raw = withValueAt(raw, override, 'cacheRun');
    return override;
  });
  const parsed = cacheRunSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `cacheRun.${i.path.join('.')}: ${i.message}`);
    throw new SettingsError(`the commitments don't match what the Cache run harness runs: ${issues.join('; ')}`);
  }
  const cacheRun = parsed.data;
  const { bigRun } = loadSettings(commitments, ci ? ['--ci'] : []);

  const schedule: ScheduledRun[] = [];
  for (let n = 0; n < cacheRun.runsPerArm; n++) {
    for (const arm of cacheRun.arms) schedule.push({ arm, ihsCaches: IHS_CACHES_OF[arm] });
  }
  return {
    kind: official ? 'official' : 'unofficial',
    bigRun: { ...bigRun, arrival: { ...bigRun.arrival, eventsPerSecond: cacheRun.eventsPerSecond } },
    cacheRun,
    schedule,
    overrides,
  };
}
