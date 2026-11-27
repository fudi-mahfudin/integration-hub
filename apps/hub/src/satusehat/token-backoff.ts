import type { Redis } from 'ioredis';
import type { Clock } from '../clock.js';
import type { Log } from '../observability/log.js';

/**
 * Until when every process must leave the token endpoint alone after a
 * failed token request (#13), shared through Redis. Redis may lose the key
 * or be down (ADR 0003): reads then find no backoff and writes are dropped,
 * and each process keeps its own backoff alongside.
 */
export interface SharedTokenBackoff {
  /** The shared backoff's end, or null when there is none (or Redis can't say). */
  until(): Promise<Date | null>;
  /** Sets the shared backoff to end at `until`. */
  set(until: Date): Promise<void>;
}

/**
 * The shared backoff as the Redis key `token_backoff_until:{token host}`,
 * holding the end in epoch milliseconds and expiring with it. The token
 * endpoint's host scopes it, since the throttle is that endpoint's. Only the
 * composition root calls this.
 */
export function createRedisTokenBackoff(deps: { redis: Redis; authUrl: URL; clock: Clock; log: Log }): SharedTokenBackoff {
  const { redis, authUrl, clock, log } = deps;
  const key = `token_backoff_until:${authUrl.host}`;
  return {
    async until() {
      try {
        const raw = await redis.get(key);
        const ms = raw === null ? Number.NaN : Number(raw);
        return Number.isFinite(ms) ? new Date(ms) : null;
      } catch (err) {
        // Safe: this process's own backoff still holds after its own failures.
        log('warn', 'reading the shared token backoff from Redis failed; only this process’s backoff applies', { error: err });
        return null;
      }
    },
    async set(until) {
      const ms = until.getTime() - clock().getTime();
      if (ms <= 0) return;
      try {
        await redis.set(key, String(until.getTime()), 'PX', ms);
      } catch (err) {
        // Safe: this process backs off on its own; other processes may make one more failed request each.
        log('warn', 'storing the shared token backoff in Redis failed; only this process backs off', { error: err });
      }
    },
  };
}
