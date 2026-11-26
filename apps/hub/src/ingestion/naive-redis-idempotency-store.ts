import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { Fingerprint } from './fingerprint.js';
import { ingestResponseSchema, type IdempotencyKey, type IdempotencyStore } from './idempotency-store.js';

/**
 * DELIBERATELY BROKEN: kept only to demonstrate ADR 0003 and never to be used
 * for real (`IDEMPOTENCY_STORE=naive-redis`).
 *
 * A Redis-only check-then-set: GET the key; if it is missing, accept the
 * event and SET the key afterwards. It passes every sequential test. Under
 * concurrent duplicates, several requests GET "missing" before any of them
 * SETs, so all of them try to accept: one wins and the rest run into the
 * case's own uniqueness and answer `409 EVENT_ALREADY_RECORDED` instead of
 * the stored `202`. Redis may also lose a key at any time, which gives a
 * duplicate ingest the same wrong answer. `test/ingest-race.test.ts` (marked
 * `test.fails` for this store) and `pnpm demo:naive-race` show it.
 */
export function createNaiveRedisIdempotencyStore(deps: {
  db: Kysely<Database>;
  redis: Redis;
  retentionHours: number;
}): IdempotencyStore {
  const { db, redis, retentionHours } = deps;
  const redisKey = (source: SourceSystemId, key: IdempotencyKey) => `naive-idempotency:${source}:${key}`;
  const entrySchema = z.object({ fingerprint: z.string(), response: ingestResponseSchema });

  return {
    async lookup(source, key) {
      const raw = await redis.get(redisKey(source, key));
      if (raw === null) return undefined;
      const entry = entrySchema.parse(JSON.parse(raw));
      // Written by `record` from a Fingerprint.
      return { fingerprint: entry.fingerprint as Fingerprint, response: entry.response };
    },

    async record(source, key, fingerprint, accept) {
      // Check-then-set: the key is written only after the accept commits.
      const accepted = await db.transaction().execute(accept);
      await redis.set(redisKey(source, key), JSON.stringify({ fingerprint, response: accepted }), 'EX', retentionHours * 3600);
      return { accepted };
    },

    // Redis expiry, set on write, is this store's purge.
    purgeExpired: () => Promise.resolve(0),
  };
}
