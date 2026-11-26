import type { Clock } from '../clock.js';
import { log } from '../observability/log.js';
import { CircuitOpen } from './errors.js';

/** The SATUSEHAT APIs the hub calls: FHIR, KFA v2 and the token endpoint, each with its own breaker (#13). */
export type PlatformApi = 'fhir' | 'kfa' | 'auth';

/** The rolling window health failures are counted over (#13). */
const WINDOW_MS = 10_000;
/** The fewest calls in the window that may open the breaker. */
const MIN_CALLS = 20;
/** The share of health failures in the window that opens it. */
const FAILURE_RATIO = 0.5;

/**
 * The circuit breaker of one platform API, in one process's memory (#13). Counts
 * only health failures (5xx, timeouts, resets; never 429 or other 4xx); opens
 * at ≥ 50% of them over ≥ 20 calls in a rolling 10s window, stays open for
 * `openMs`, then admits one probe: healthy closes it, unhealthy opens it again.
 */
export interface CircuitBreaker {
  /**
   * Admits one call, or throws `CircuitOpen` while open (or half-open with
   * its probe out). Returns how to report the call's health once it ends.
   */
  admit(): (healthy: boolean) => void;
  /** Whether it refuses calls now: a worker claims nothing while any breaker is open. */
  isOpen(): boolean;
}

/** Builds one platform API's breaker. Only the composition root (and its tests) call this. */
export function createCircuitBreaker(deps: { api: PlatformApi; clock: Clock; openMs: number }): CircuitBreaker {
  const { api, clock, openMs } = deps;
  const now = () => clock().getTime();
  let recent: { atMs: number; healthy: boolean }[] = [];
  let openUntilMs: number | null = null;
  let probeOut = false;

  const halfOpen = () => openUntilMs !== null && now() >= openUntilMs;

  function open(reason: string): void {
    openUntilMs = now() + openMs;
    recent = [];
    log('warn', `circuit breaker opened: ${reason}`, { api, openUntil: new Date(openUntilMs).toISOString() });
  }

  function record(healthy: boolean): void {
    // A call admitted before the breaker opened ends after it: its health no longer counts.
    if (openUntilMs !== null) return;
    const at = now();
    recent = recent.filter((c) => at - c.atMs < WINDOW_MS);
    recent.push({ atMs: at, healthy });
    const failures = recent.filter((c) => !c.healthy).length;
    if (recent.length >= MIN_CALLS && failures / recent.length >= FAILURE_RATIO) {
      open(`${failures} of the last ${recent.length} calls failed`);
    }
  }

  return {
    admit() {
      if (openUntilMs === null) return record;
      if (!halfOpen() || probeOut) throw new CircuitOpen(api);
      probeOut = true;
      return (healthy) => {
        probeOut = false;
        if (!healthy) return open('the probe failed');
        openUntilMs = null;
        log('info', 'circuit breaker closed: the probe succeeded', { api });
      };
    },
    isOpen: () => openUntilMs !== null && (!halfOpen() || probeOut),
  };
}
