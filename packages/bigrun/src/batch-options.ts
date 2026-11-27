// The simulator's batch for a committed big run, shared by the big run and the Cache run.
import type { BatchOptions } from '@integration-hub/simulator';
import type { BigRunCommitments } from './settings.js';

/** The simulator's batch options for `bigRun`: its seed, visits, arrival rate, event mix and duplicates, under `runId`. */
export function batchOptions(bigRun: BigRunCommitments, runId: string): BatchOptions {
  return {
    seed: bigRun.seed,
    runId,
    visits: bigRun.events.visits,
    eventsPerSecond: bigRun.arrival.eventsPerSecond,
    outOfOrder: { share: bigRun.eventMix.outOfOrder, delayMs: bigRun.eventMix.outOfOrderHoldSeconds * 1000 },
    substitutionShare: bigRun.eventMix.substitution,
    fallbackLookupShare: bigRun.eventMix.fallbackPersonLookup,
    duplicates: {
      perEvent: bigRun.events.duplicates / bigRun.events.uniqueEvents,
      concurrent: bigRun.duplicateTiming.concurrent,
      delayed: bigRun.duplicateTiming.delayed,
      late: bigRun.duplicateTiming.late,
      delayedWindowMs: { min: bigRun.duplicateTiming.delayedWindowSeconds.min * 1000, max: bigRun.duplicateTiming.delayedWindowSeconds.max * 1000 },
    },
  };
}

