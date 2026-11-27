// What a big run is run with: the committed `bigRun` section of
// bigrun.commitments.json, and the command line that may scale it down for CI
// or override it. Only an unmodified run may be official.
import { z } from 'zod';

const share = z.number().min(0).max(1);
const percent = z.number().min(0).max(100);
const limits = z.object({ cpus: z.number().positive(), memory: z.string().regex(/^\d+[mg]$/) });

const bigRunSchema = z.object({
  seed: z.number().int().min(0).max(4_294_967_295),
  events: z.object({
    visits: z.number().int().min(1),
    eventsPerVisit: z.literal(4),
    uniqueEvents: z.number().int(),
    duplicates: z.number().int().min(0),
    total: z.number().int(),
    allValid: z.literal(true),
  }),
  duplicateTiming: z.object({
    concurrent: share,
    delayed: share,
    delayedWindowSeconds: z.object({ min: z.number().min(0), max: z.number().min(0) }),
    late: share,
  }),
  eventMix: z.object({ outOfOrder: share, substitution: share, fallbackPersonLookup: share, outOfOrderHoldSeconds: z.number().min(0) }),
  faults: z.object({
    excludes: z.array(z.literal('token')).length(1),
    params: z.object({ retryAfterSeconds: z.number().int().min(0), timeoutHoldSeconds: z.number().positive() }),
    reads: z.object({
      totalPercent: percent,
      weights: z.object({ http_500: percent, http_503: percent, http_429: percent, timeout: percent, connection_reset: percent }).strict(),
      variants: z.object({
        http_503: z.object({ withRetryAfter: share }),
        http_429: z.object({ retryAfter: z.object({ absent: z.number().min(0), seconds: z.number().min(0), httpDate: z.number().min(0) }) }),
      }),
    }),
    writes: z.object({
      totalPercent: percent,
      weights: z
        .object({
          timeout_after_apply: percent,
          http_500_after_apply: percent,
          http_500: percent,
          http_503: percent,
          http_429: percent,
          timeout: percent,
          connection_reset: percent,
        })
        .strict(),
    }),
  }),
  mockProfile: z.object({ rateLimitRps: z.object({ fhir: z.number().positive(), kfa: z.number().positive() }), callTimeoutSeconds: z.number().positive() }),
  tracing: z.object({ sampleRatio: share }),
  arrival: z.object({ mode: z.literal('open-loop'), eventsPerSecond: z.number().positive() }),
  topology: z.object({
    hubServices: z.literal(1),
    workerProcesses: z.number().int().min(1),
    composeLimits: z.object({ hub: limits, worker: limits, mock: limits, postgres: limits, redis: limits, prometheus: limits }),
  }),
  reconciliation: z.object({ periodic: z.literal(false), afterDrain: z.literal('information-only') }),
  completion: z.object({
    pollIntervalSeconds: z.number().positive(),
    noProgressFailFastMinutes: z.number().positive(),
    hardDeadlineMinutes: z.number().positive(),
  }),
  invariants: z.object({
    lostEvents: z.literal(0),
    duplicateSubmissions: z.literal(0),
    orderPerCase: z.literal('preserved'),
    hubSide: z.object({
      completedCases: z.number().int(),
      waitingCases: z.literal(0),
      deadLetteredCases: z.literal(0),
      abandonedCases: z.literal(0),
      completedSteps: z.number().int(),
    }),
    mockSide: z.object({
      effectsPerVisitInOrder: z.tuple([
        z.literal('Encounter created'),
        z.literal('MedicationRequest created'),
        z.literal('MedicationDispense created'),
        z.literal('Encounter updated'),
      ]),
      mockReportSectionsEmpty: z.tuple([z.literal('duplicates'), z.literal('outOfOrder'), z.literal('overlap')]),
    }),
    responses: z.object({ original: z.literal('202'), duplicate: z.literal('202 + Idempotent-Replayed') }),
  }),
});

/** The committed big run: every parameter the harness runs and judges by. */
export type BigRunCommitments = z.infer<typeof bigRunSchema>;

/**
 * What kind of run this is. `official`: the committed run, unmodified, from a
 * clean tree; only these are published. `ci`: the committed run scaled down to
 * the committed CI visits (`ciRun.visits`). `unofficial`: anything else, such as a run with
 * `--set` overrides.
 */
export type RunKind = 'official' | 'ci' | 'unofficial';

/** One `--set path=value`: a committed value this run replaced. */
export interface Override {
  /** Dotted path under the run's section of the commitments file, e.g. `arrival.eventsPerSecond` under `bigRun`. */
  path: string;
  value: unknown;
}

/** What one run is run with. */
export interface Settings {
  kind: RunKind;
  /** The commitments after any CI scaling and overrides. */
  bigRun: BigRunCommitments;
  /** Every override, flagged in the report. */
  overrides: Override[];
}

/** Thrown for a command line or commitments file the harness can't run with. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}


/**
 * Reads the `bigRun` section of the parsed commitments file and applies the
 * command line: `--official`, `--ci`, and any number of `--set path=value`
 * (the value is read as JSON, else as a string). Throws {@link SettingsError}
 * for an unknown flag, `--official` with anything that changes the run, an
 * override of a path the commitments don't have, or counts that don't add up.
 */
export function loadSettings(commitments: unknown, argv: readonly string[]): Settings {
  const args = parseArgs(argv);
  if (args.official && (args.ci || args.sets.length > 0)) {
    throw new SettingsError(`--official runs the committed big run unchanged, so it can't be combined with ${args.ci ? '--ci' : '--set'}`);
  }
  const root = z.object({ bigRun: z.record(z.string(), z.unknown()), ciRun: z.object({ visits: z.number().int().min(1) }) }).safeParse(commitments);
  if (!root.success) throw new SettingsError('the commitments file must hold a "bigRun" object and "ciRun.visits"');
  let raw: unknown = structuredClone(root.data.bigRun);
  if (args.ci) raw = scaledForCi(parse(raw), root.data.ciRun.visits);
  const overrides = args.sets.map((set) => {
    const override = parseOverride(set);
    raw = withValueAt(raw, override, 'bigRun');
    return override;
  });
  const bigRun = parse(raw);
  checkConsistency(bigRun);
  return { kind: args.official ? 'official' : args.ci ? 'ci' : 'unofficial', bigRun, overrides };
}

function parseArgs(argv: readonly string[]): { official: boolean; ci: boolean; sets: string[] } {
  const parsed: { official: boolean; ci: boolean; sets: string[] } = { official: false, ci: false, sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--official') parsed.official = true;
    else if (arg === '--ci') parsed.ci = true;
    else if (arg === '--set') {
      const value = argv[++i];
      if (value === undefined) throw new SettingsError('--set needs path=value after it');
      parsed.sets.push(value);
    } else throw new SettingsError(`unknown argument "${arg}": expected --official, --ci or --set path=value`);
  }
  return parsed;
}

function parse(raw: unknown): BigRunCommitments {
  const parsed = bigRunSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `bigRun.${i.path.join('.')}: ${i.message}`);
  throw new SettingsError(`the commitments don't match what the harness runs: ${issues.join('; ')}`);
}

/** One `--set path=value` argument as an override; the value is read as JSON, else as the text itself. */
export function parseOverride(set: string): Override {
  const at = set.indexOf('=');
  if (at <= 0) throw new SettingsError(`--set needs path=value, got "${set}"`);
  const path = set.slice(0, at);
  const text = set.slice(at + 1);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: the value is the text itself, e.g. `--set cache=off`.
    value = text;
  }
  return { path, value };
}

/** A copy of `raw`, the commitments file's `section`, with the override's value at its path, which must already exist. */
export function withValueAt(raw: unknown, override: Override, section: string): unknown {
  const copy: unknown = structuredClone(raw);
  const keys = override.path.split('.');
  let node: unknown = copy;
  for (const [i, key] of keys.entries()) {
    if (typeof node !== 'object' || node === null || !(key in node)) {
      throw new SettingsError(`--set ${override.path}: ${section} has no "${keys.slice(0, i + 1).join('.')}"`);
    }
    // An object, checked just above.
    const record = node as Record<string, unknown>;
    if (i === keys.length - 1) record[key] = override.value;
    else node = record[key];
  }
  return copy;
}

/** The big run at the committed CI visits (`ciRun.visits`): every count scaled, every ratio, weight and deadline kept. */
function scaledForCi(bigRun: BigRunCommitments, visits: number): BigRunCommitments {
  const { events } = bigRun;
  const uniqueEvents = visits * events.eventsPerVisit;
  const duplicates = Math.round((uniqueEvents * events.duplicates) / events.uniqueEvents);
  return {
    ...bigRun,
    events: { ...events, visits, uniqueEvents, duplicates, total: uniqueEvents + duplicates },
    invariants: { ...bigRun.invariants, hubSide: { ...bigRun.invariants.hubSide, completedCases: visits, completedSteps: uniqueEvents } },
  };
}

function checkConsistency(bigRun: BigRunCommitments): void {
  const { events, duplicateTiming, faults, invariants } = bigRun;
  const problems: string[] = [];
  const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);
  if (events.uniqueEvents !== events.visits * events.eventsPerVisit) {
    problems.push(`events.uniqueEvents must be visits × eventsPerVisit (${events.visits * events.eventsPerVisit}), got ${events.uniqueEvents}`);
  }
  if (events.total !== events.uniqueEvents + events.duplicates) {
    problems.push(`events.total must be uniqueEvents + duplicates (${events.uniqueEvents + events.duplicates}), got ${events.total}`);
  }
  if (events.duplicates > events.uniqueEvents) problems.push(`events.duplicates must not exceed uniqueEvents, got ${events.duplicates}`);
  if (Math.abs(duplicateTiming.concurrent + duplicateTiming.delayed + duplicateTiming.late - 1) > 1e-9) {
    problems.push('duplicateTiming.concurrent, delayed and late must sum to 1');
  }
  if (duplicateTiming.delayedWindowSeconds.min > duplicateTiming.delayedWindowSeconds.max) {
    problems.push('duplicateTiming.delayedWindowSeconds.min must not exceed max');
  }
  for (const group of ['reads', 'writes'] as const) {
    const weights = sum(faults[group].weights);
    if (Math.abs(weights - faults[group].totalPercent) > 1e-9) {
      problems.push(`faults.${group}: the weights must sum to totalPercent (${faults[group].totalPercent}), got ${weights}`);
    }
  }
  if (sum(faults.reads.variants.http_429.retryAfter) <= 0) problems.push('faults.reads.variants.http_429.retryAfter needs a positive share');
  if (invariants.hubSide.completedCases !== events.visits) {
    problems.push(`invariants.hubSide.completedCases must be events.visits (${events.visits}), got ${invariants.hubSide.completedCases}`);
  }
  if (invariants.hubSide.completedSteps !== events.uniqueEvents) {
    problems.push(`invariants.hubSide.completedSteps must be events.uniqueEvents (${events.uniqueEvents}), got ${invariants.hubSide.completedSteps}`);
  }
  if (problems.length > 0) throw new SettingsError(`the commitments don't add up: ${problems.join('; ')}`);
}
