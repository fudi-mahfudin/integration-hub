import { z } from 'zod';
import type { BatchOptions } from './plan.js';
import type { HubTarget } from './run.js';

/** The simulator's settings, read from the environment once. */
export interface SimulatorConfig {
  /** Where to send, and as which source system. */
  hub: HubTarget;
  /** What the simulated batch is made of. */
  batch: BatchOptions;
  /** How often an unfinished case is read. */
  pollIntervalMs: number;
  /** How long the cases may take to complete after the last original send. */
  completionTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

const share = z.coerce.number().min(0).max(1);
const ms = z.coerce.number().int().min(0);

/**
 * The variables and their defaults: a small batch with the big run's ratios
 * (bigrun.commitments.json), against a hub on localhost with the public
 * development source key. A clean clone needs no `.env`.
 */
const VARIABLES = {
  HUB_URL: [z.url(), 'http://localhost:3000/'],
  SIM_API_KEY: [z.string().min(1), 'dev-source-key'],
  SIM_SEED: [z.coerce.number().int().min(0).max(4_294_967_295), '44'],
  SIM_VISITS: [z.coerce.number().int().min(1).max(100_000), '20'],
  SIM_EVENTS_PER_SECOND: [z.coerce.number().positive().max(10_000), '10'],
  SIM_OUT_OF_ORDER_SHARE: [share, '0.1'],
  SIM_OUT_OF_ORDER_DELAY_MS: [ms, '2000'],
  SIM_SUBSTITUTION_SHARE: [share, '0.1'],
  SIM_FALLBACK_LOOKUP_SHARE: [share, '0.1'],
  SIM_DUPLICATES_PER_EVENT: [share, '0.25'],
  SIM_DUPLICATES_CONCURRENT: [share, '0.5'],
  SIM_DUPLICATES_DELAYED: [share, '0.3'],
  SIM_DUPLICATES_LATE: [share, '0.2'],
  SIM_DUPLICATE_DELAY_MIN_MS: [ms, '500'],
  SIM_DUPLICATE_DELAY_MAX_MS: [ms, '10000'],
  SIM_POLL_INTERVAL_MS: [z.coerce.number().int().min(10), '1000'],
  SIM_COMPLETION_TIMEOUT_MS: [ms, '300000'],
} as const;

type Variable = keyof typeof VARIABLES;

/**
 * Reads and validates the simulator's configuration. `SIM_RUN_ID` defaults to
 * one taken from the clock, so a rerun against the same hub opens new cases;
 * everything else in the batch follows from the seed. Throws naming the bad variable.
 */
export function loadConfig(env: Env, now: Date): SimulatorConfig {
  const read = <V extends Variable>(name: V): z.output<(typeof VARIABLES)[V][0]> => {
    const [schema, fallback] = VARIABLES[name];
    const raw = env[name] ?? fallback;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`${name} ${parsed.error.issues[0]?.message ?? 'is invalid'}, got "${raw}"`);
    // safeParse of this variable's own schema: the output type is the one declared.
    return parsed.data as z.output<(typeof VARIABLES)[V][0]>;
  };
  const runId = env.SIM_RUN_ID ?? now.getTime().toString(36).toUpperCase();
  if (!/^[A-Za-z0-9]{1,16}$/.test(runId)) throw new Error(`SIM_RUN_ID must be 1-16 letters or digits, got "${runId}"`);
  const timing = { concurrent: read('SIM_DUPLICATES_CONCURRENT'), delayed: read('SIM_DUPLICATES_DELAYED'), late: read('SIM_DUPLICATES_LATE') };
  if (Math.abs(timing.concurrent + timing.delayed + timing.late - 1) > 1e-9) {
    throw new Error(`SIM_DUPLICATES_CONCURRENT, SIM_DUPLICATES_DELAYED and SIM_DUPLICATES_LATE must sum to 1, got ${timing.concurrent}, ${timing.delayed} and ${timing.late}`);
  }
  const delayWindow = { min: read('SIM_DUPLICATE_DELAY_MIN_MS'), max: read('SIM_DUPLICATE_DELAY_MAX_MS') };
  if (delayWindow.min > delayWindow.max) {
    throw new Error(`SIM_DUPLICATE_DELAY_MIN_MS must not exceed SIM_DUPLICATE_DELAY_MAX_MS, got ${delayWindow.min} and ${delayWindow.max}`);
  }
  return {
    hub: { baseUrl: new URL(read('HUB_URL')), apiKey: read('SIM_API_KEY') },
    batch: {
      seed: read('SIM_SEED'),
      runId,
      visits: read('SIM_VISITS'),
      eventsPerSecond: read('SIM_EVENTS_PER_SECOND'),
      outOfOrder: { share: read('SIM_OUT_OF_ORDER_SHARE'), delayMs: read('SIM_OUT_OF_ORDER_DELAY_MS') },
      substitutionShare: read('SIM_SUBSTITUTION_SHARE'),
      fallbackLookupShare: read('SIM_FALLBACK_LOOKUP_SHARE'),
      duplicates: { perEvent: read('SIM_DUPLICATES_PER_EVENT'), ...timing, delayedWindowMs: delayWindow },
    },
    pollIntervalMs: read('SIM_POLL_INTERVAL_MS'),
    completionTimeoutMs: read('SIM_COMPLETION_TIMEOUT_MS'),
  };
}
