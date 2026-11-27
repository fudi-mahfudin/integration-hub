// The Cache run's bar to stay (#20), judged per cache against the arm without
// it: from each run's measurements, whether the cache cut upstream reads and
// end-to-end case time by the committed amounts.
import type { ArmName, CacheRunCommitments } from './settings.js';

/** What the bar reads of one run. */
export interface ArmRun {
  arm: ArmName;
  /** Read calls the mock received (GET: FHIR searches and KFA lookups), per completed case; null when no case completed. */
  upstreamReadsPerCompletedCase: number | null;
  /** p95 of the completed cases' end-to-end times; null when no case completed. */
  endToEndP95Seconds: number | null;
}

/** One cache's judgement. */
export interface CacheDecision {
  /** The cache judged. */
  cache: 'ihs_practitioner' | 'ihs_patient';
  /** The arm with the cache. */
  with: ArmName;
  /** The arm without it, otherwise the same. */
  against: ArmName;
  /** Bar 1: the median reads per completed case drop by at least the committed share. */
  upstreamReads: { medianWithout: number | null; medianWith: number | null; reduction: number | null; pass: boolean };
  /**
   * Bar 2: the median of the runs' e2e p95 improves by at least the committed
   * share, and by more than the max-min spread of the runs. The commitment
   * doesn't say which arm's spread, so it must exceed both: `spreadSeconds`
   * is the larger.
   */
  endToEndP95: {
    medianWithoutSeconds: number | null;
    medianWithSeconds: number | null;
    improvement: number | null;
    spreadSeconds: number | null;
    pass: boolean;
  };
  /** Bars 1 and 2. Bar 3, an official big run passing with the cache on, is judged by that run, not here. */
  measuredBarsPass: boolean;
}

/** Each cache, the arm with it, and the arm without it. */
const COMPARISONS = [
  { cache: 'ihs_practitioner', with: 'ihs_practitioner only', against: 'no cache' },
  { cache: 'ihs_patient', with: 'ihs_patient + ihs_practitioner', against: 'ihs_practitioner only' },
] as const;

/** Judges every cache whose two arms both have runs in `runs`. */
export function judgeCaches(runs: readonly ArmRun[], bar: CacheRunCommitments['barToStay']): CacheDecision[] {
  const of = (arm: ArmName) => runs.filter((r) => r.arm === arm);
  return COMPARISONS.flatMap((comparison) => {
    const withRuns = of(comparison.with);
    const withoutRuns = of(comparison.against);
    if (withRuns.length === 0 || withoutRuns.length === 0) return [];

    const readsOfWithout = present(withoutRuns.map((r) => r.upstreamReadsPerCompletedCase));
    const readsOfWith = present(withRuns.map((r) => r.upstreamReadsPerCompletedCase));
    // A run where no case completed has no reads per case: the arm can't be judged.
    const readsComplete = readsOfWithout.length === withoutRuns.length && readsOfWith.length === withRuns.length;
    const readsWithout = median(readsOfWithout);
    const readsWith = median(readsOfWith);
    const reduction = !readsComplete || readsWithout === null || readsWith === null || readsWithout === 0 ? null : round(1 - readsWith / readsWithout);
    const readsPass = reduction !== null && reduction >= bar.upstreamReadsPerCompletedCaseReduction;

    const p95sWithout = present(withoutRuns.map((r) => r.endToEndP95Seconds));
    const p95sWith = present(withRuns.map((r) => r.endToEndP95Seconds));
    // A run where no case completed has no p95: the arm can't be judged.
    const complete = p95sWithout.length === withoutRuns.length && p95sWith.length === withRuns.length;
    const p95Without = median(p95sWithout);
    const p95With = median(p95sWith);
    const improvement = !complete || p95Without === null || p95With === null || p95Without === 0 ? null : round(1 - p95With / p95Without);
    const spread = complete ? Math.max(spreadOf(p95sWithout), spreadOf(p95sWith)) : null;
    const e2ePass =
      improvement !== null &&
      p95Without !== null &&
      p95With !== null &&
      spread !== null &&
      improvement >= bar.medianE2eCaseP95Improvement &&
      p95Without - p95With > spread;

    return [
      {
        cache: comparison.cache,
        with: comparison.with,
        against: comparison.against,
        upstreamReads: { medianWithout: readsWithout, medianWith: readsWith, reduction, pass: readsPass },
        endToEndP95: { medianWithoutSeconds: p95Without, medianWithSeconds: p95With, improvement, spreadSeconds: spread, pass: e2ePass },
        measuredBarsPass: readsPass && e2ePass,
      },
    ];
  });
}

/** The median of a sample (the mean of the middle two for an even size), or null for an empty one. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

function spreadOf(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function present(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

/** Rounded to 6 decimals, so a share reads as it was computed, not with float noise (0.15, not 0.15000000000000002). */
function round(share: number): number {
  return Math.round(share * 1e6) / 1e6;
}
