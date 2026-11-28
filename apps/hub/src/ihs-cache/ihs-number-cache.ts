import { createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Brand } from '../brand.js';
import type { Nik } from '../ingestion/event-schema.js';
import type { Log } from '../observability/log.js';
import type { IhsNumber } from '../satusehat/client.js';

/**
 * The IHS-number cache (#20, #47): practitioners' IHS numbers found by exact
 * NIK lookup, named so in `IHS_CACHES` and in `cache_requests_total`.
 */
export const IHS_CACHE = 'ihs_practitioner';

/**
 * The patient cache, measured alongside it and removed: it missed the Cache
 * run bar. `IHS_CACHES` naming it is refused, pointing at the result.
 */
export const REMOVED_IHS_CACHE = { name: 'ihs_patient', removedBy: 'results/cache/2026-11-28-d0550b0' } as const;

/** Where an attempt took a looked-up IHS number from (#47): the cache, or a search at SATUSEHAT. */
export type LookupSource = 'cache' | 'remote';

/**
 * A cache entry's Redis key, `ihs:practitioner:{HMAC-SHA256(NIK, pepper)}`:
 * it never holds the NIK itself, and without the pepper a 16-digit NIK can't be brute-forced from it.
 */
export type IhsCacheKey = Brand<string, 'IhsCacheKey'>;

/** The result of one cache request (#20): `bypass` is a replay, which reads past the cache; `error` a Redis failure or timeout, treated as a miss. */
export type CacheResult = 'hit' | 'miss' | 'bypass' | 'error';

/** What a NIK lookup through the cache found, and where from. */
export interface CachedLookup {
  /** The IHS numbers found: one from the cache, or whatever the search found. */
  found: IhsNumber[];
  /** Where `found` came from. */
  source: LookupSource;
  /** The entry the lookup read or wrote; null when this cache is off. */
  key: IhsCacheKey | null;
}

/**
 * The IHS-number cache (#47). A cache is never load-bearing (ADR 0003): the
 * hub stays correct if Redis loses any entry, is down, or is slow.
 */
export interface IhsNumberCache {
  /**
   * Finds the practitioners with `nik`, through the cache: a hit answers
   * without `search`; a miss runs it, and caches the one IHS number found.
   * With `bypass` (a replayed step re-resolves everything), the cache is not
   * read, and the one IHS number found overwrites the entry. Nothing else is
   * cached: no match, or more than one. A Redis error, or an answer slower
   * than 50ms, is a miss; a failed write is ignored. Only exact NIK lookups
   * come through here: the fallbacks are never cached.
   */
  findByNik(nik: Nik, search: () => Promise<IhsNumber[]>, options: { bypass: boolean }): Promise<CachedLookup>;
  /** Deletes these entries (after a permanent rejection of the write that used them); a Redis failure is ignored. */
  forget(keys: readonly IhsCacheKey[]): Promise<void>;
}

/** How long a cache request may take before it counts as a miss (#20). */
const REDIS_TIMEOUT_MS = 50;
/** How long an entry lives (#20): this bounds how long personal data stays in Redis, and how long a re-pointed NIK could be served stale. */
const TTL_SECONDS = 24 * 60 * 60;

/** A Redis command took longer than the cache waits. */
class CacheTimeout extends Error {
  constructor() {
    super(`Redis did not answer within ${REDIS_TIMEOUT_MS}ms`);
    this.name = 'CacheTimeout';
  }
}

/**
 * The cache in Redis, on unless `enabled` is false (the Cache run's "no
 * cache" arm, #47); with it off, a lookup always searches. Only the
 * composition root calls this.
 */
export function createIhsNumberCache(deps: {
  redis: Redis;
  /** The secret the NIK is keyed with (`IHS_CACHE_PEPPER`). */
  pepper: string;
  enabled: boolean;
  log: Log;
  metrics: { cacheRequest(result: CacheResult): void };
}): IhsNumberCache {
  const { redis, pepper, enabled, log, metrics } = deps;
  const keyOf = (nik: Nik) =>
    // Brands the key this function alone builds.
    `ihs:practitioner:${createHmac('sha256', pepper).update(nik).digest('hex')}` as IhsCacheKey;

  async function write(key: IhsCacheKey, ihsNumber: IhsNumber): Promise<void> {
    try {
      await timed(redis.set(key, ihsNumber, 'EX', TTL_SECONDS));
    } catch (err) {
      // Safe: the cache is never load-bearing; the next lookup searches again.
      log('warn', 'writing an IHS-number cache entry failed; it is not cached', { error: err });
    }
  }

  async function forget(keys: readonly IhsCacheKey[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await timed(redis.del(...keys));
    } catch (err) {
      // Safe: the entries expire within 24h, and a step that reads a wrong one is rejected again.
      log('warn', 'deleting IHS-number cache entries failed; they stay until they expire', { error: err });
    }
  }

  return {
    async findByNik(nik, search, { bypass }) {
      if (!enabled) return { found: await search(), source: 'remote', key: null };
      const key = keyOf(nik);
      if (bypass) {
        metrics.cacheRequest('bypass');
      } else {
        try {
          const cached = await timed(redis.get(key));
          metrics.cacheRequest(cached === null ? 'miss' : 'hit');
          // Written only by `write`, from an IHS number a search found.
          if (cached !== null) return { found: [cached as IhsNumber], source: 'cache', key };
        } catch (err) {
          metrics.cacheRequest('error');
          // Safe: a cache that can't answer is a miss, and the search below answers instead.
          log('warn', 'reading the IHS-number cache failed; the IHS number is searched for', { error: err });
        }
      }
      const found = await search();
      const [one] = found;
      if (one !== undefined && found.length === 1) await write(key, one);
      return { found, source: 'remote', key };
    },
    forget,
  };
}

/** `command`, or a `CacheTimeout` once it has taken longer than the cache waits. */
async function timed<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CacheTimeout()), REDIS_TIMEOUT_MS);
  });
  // A command still pending at the timeout is left to settle on its own; its result is ignored.
  command.catch(() => {});
  try {
    return await Promise.race([command, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
