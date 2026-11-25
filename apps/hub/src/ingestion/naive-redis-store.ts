import type { SourceSystem } from '../auth/source-systems.js';
import type { IdempotencyStore, IngestDeps, StoredKey } from './ingest.js';

/**
 * DELIBERATELY BROKEN. Kept only to demonstrate ADR 0003; never run it in
 * production (`IDEMPOTENCY_STORE=naive-redis`).
 *
 * A Redis-only check-then-set: GET the key, and if it is missing, accept the
 * event and SET the key afterwards. It passes every sequential test. Under
 * concurrent duplicates, several requests all GET "missing" before any of
 * them SETs, so all of them try to accept; the first wins and the rest hit
 * the case's own uniqueness and answer `409 EVENT_ALREADY_RECORDED` instead
 * of returning the stored `202`. Redis may also lose keys at any time,
 * which turns a duplicate ingest into the same wrong answer. The race test in
 * `test/ingest-race.test.ts` (marked `test.fails` for this store) and
 * `pnpm demo:naive-race` show it.
 */
export function createNaiveRedisStore({ db, redis, config }: IngestDeps): IdempotencyStore {
  const redisKey = (source: SourceSystem, key: string) => `naive-idempotency:${source.id}:${key}`;

  return {
    async lookup(source, key) {
      const raw = await redis.get(redisKey(source, key));
      return raw === null ? undefined : (JSON.parse(raw) as StoredKey);
    },

    async record(source, key, fingerprint, accept) {
      const response = await db.transaction().execute(accept);
      const stored: StoredKey = { fingerprint, response };
      await redis.set(redisKey(source, key), JSON.stringify(stored), 'EX', config.idempotencyRetentionHours * 3600);
      return response;
    },

    // Redis expiry (set on write) is the purge.
    purgeExpired: async () => 0,
  };
}
