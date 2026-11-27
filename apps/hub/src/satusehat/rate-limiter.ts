import type { Redis } from 'ioredis';
import type { Clock } from '../clock.js';
import type { Log } from '../observability/log.js';
import type { LimiterMode, WorkerMetrics } from '../observability/metrics.js';
import { inSpan } from '../observability/tracing.js';
import type { PlatformApi } from './circuit-breaker.js';

/** The platform APIs the hub rate-limits itself on (#13); the token endpoint has its own backoff instead. */
export type RateLimitedApi = Exclude<PlatformApi, 'auth'>;

/** The longest a 429's `Retry-After` holds off a platform API's calls (#13). */
const PAUSE_CAP_MS = 30_000;

/**
 * The hub's own request rate per platform API (#13): one token bucket each,
 * shared by every worker process through Redis, with a burst of one second's
 * worth. While Redis can't answer, each process falls back to a bucket of its
 * own at the shared rate ÷ the configured worker count, so a limiter never
 * stops the system (ADR 0003).
 */
export interface RateLimiter {
  /** Resolves once a call to `api` may be sent. */
  acquire(api: RateLimitedApi): Promise<void>;
  /**
   * After `api` answered 429: no call to it before `until` (its
   * `Retry-After`), clamped to 30s from now; from any process while Redis
   * answers, from this one otherwise. Without a hint, nothing changes.
   */
  holdOff(api: RateLimitedApi, until: Date | null): Promise<void>;
  /** Which bucket the next call would come from: the shared one while Redis is connected, else the process's own. For readiness (#43). */
  mode(): LimiterMode;
}

/**
 * GCRA, the token bucket kept as one number: the theoretical arrival time
 * (ms) of the next call. Reserves one call and returns how long to wait for
 * it (ms). KEYS[1] the bucket; ARGV now, interval between calls, burst.
 */
const RESERVE = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local tat = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), now)
local wait = math.max(tat - now - (burst - 1) * interval, 0)
local later = tat + interval
redis.call('SET', KEYS[1], tostring(later), 'PX', math.ceil(later - now) + 1000)
return tostring(wait)
`;

/** Holds the bucket's next call back to `until` at the earliest. ARGV now, until, interval, burst. */
const PAUSE = `
local now = tonumber(ARGV[1])
local held = tonumber(ARGV[2]) + (tonumber(ARGV[4]) - 1) * tonumber(ARGV[3])
local tat = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), held)
redis.call('SET', KEYS[1], tostring(tat), 'PX', math.ceil(tat - now) + 1000)
return 1
`;

/** One bucket's arithmetic, shared by the Redis script's caller and the local fallback. */
interface Bucket {
  intervalMs: number;
  burst: number;
}

/** A bucket of `rps`, with a burst of one second's worth (never less than one call). */
const bucketOf = (rps: number): Bucket => ({ intervalMs: 1000 / rps, burst: Math.max(1, rps) });

/**
 * Builds the limiter over the worker's optional Redis, as the Redis keys
 * `rate_limit_tat:{api}:{host}`. Only the composition root calls this.
 */
export function createRateLimiter(deps: {
  redis: Redis;
  clock: Clock;
  /** The base URL of each platform API: its host scopes the shared bucket, since the limit is that platform's. */
  urls: Record<RateLimitedApi, URL>;
  /** The shared rate of each platform API, in calls per second. */
  rps: Record<RateLimitedApi, number>;
  /** How many worker processes share the rate: a process alone without Redis takes this share of it. */
  workerProcesses: number;
  log: Log;
  metrics: Pick<WorkerMetrics, 'limiterWaited'>;
}): RateLimiter {
  const { redis, clock, urls, rps, workerProcesses, log, metrics } = deps;
  const now = () => clock().getTime();
  const shared = { fhir: bucketOf(rps.fhir), kfa: bucketOf(rps.kfa) };
  const own = { fhir: bucketOf(rps.fhir / workerProcesses), kfa: bucketOf(rps.kfa / workerProcesses) };
  const ownTat: Record<RateLimitedApi, number> = { fhir: 0, kfa: 0 };
  let usingOwn = false;
  const key = (api: RateLimitedApi) => `rate_limit_tat:${api}:${urls[api].host}`;

  function reserveOwn(api: RateLimitedApi, at: number): number {
    const { intervalMs, burst } = own[api];
    const tat = Math.max(ownTat[api], at);
    ownTat[api] = tat + intervalMs;
    return Math.max(tat - at - (burst - 1) * intervalMs, 0);
  }

  function fellBack(err: unknown): void {
    if (usingOwn) return;
    usingOwn = true;
    // Safe: each process keeps to its share of the rate on its own.
    log('warn', `the shared rate limit is unreachable in Redis; this process keeps to 1/${workerProcesses} of the rate on its own`, { error: err });
  }

  function recovered(): void {
    if (!usingOwn) return;
    usingOwn = false;
    log('info', 'the shared rate limit is reachable in Redis again');
  }

  /** Reserves one call: how long to wait for it, and which bucket it came from. */
  async function reserve(api: RateLimitedApi): Promise<{ waitMs: number; mode: LimiterMode }> {
    const at = now();
    const { intervalMs, burst } = shared[api];
    try {
      const waitMs = Number(await redis.eval(RESERVE, 1, key(api), at, intervalMs, burst));
      recovered();
      return { waitMs, mode: 'redis' };
    } catch (err) {
      fellBack(err);
      return { waitMs: reserveOwn(api, at), mode: 'local_fallback' };
    }
  }

  return {
    async acquire(api) {
      const { waitMs, mode } = await reserve(api);
      metrics.limiterWaited(api, mode, waitMs / 1000);
      if (waitMs > 0) {
        // Only a call that waits makes a span (#15).
        await inSpan('rate_limiter.wait', { api, mode, 'wait.ms': waitMs }, () => new Promise((resolve) => setTimeout(resolve, waitMs)));
      }
    },
    async holdOff(api, until) {
      if (until === null) return;
      const at = now();
      const untilMs = Math.min(until.getTime(), at + PAUSE_CAP_MS);
      if (untilMs <= at) return;
      log('warn', 'SATUSEHAT answered 429; the rate limit holds calls off until its Retry-After', { api, until: new Date(untilMs).toISOString() });
      const { intervalMs, burst } = own[api];
      ownTat[api] = Math.max(ownTat[api], untilMs + (burst - 1) * intervalMs);
      try {
        const s = shared[api];
        await redis.eval(PAUSE, 1, key(api), at, untilMs, s.intervalMs, s.burst);
        recovered();
      } catch (err) {
        fellBack(err);
      }
    },
    // Commands fail at once while the connection is not ready (no offline queue), so the next call falls back.
    mode: () => (redis.status === 'ready' ? 'redis' : 'local_fallback'),
  };
}
