import type { Kysely } from 'kysely';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { Fingerprint } from './fingerprint.js';
import {
  ingestResponseSchema,
  type IdempotencyKey,
  type IdempotencyStore,
  type IngestResponse,
  type StoredKey,
} from './idempotency-store.js';

/** Thrown inside the transaction to roll it back when another request already holds the key. */
class KeyTaken extends Error {
  constructor() {
    super('the idempotency key is held by a request that committed first');
    this.name = 'KeyTaken';
  }
}

const HOUR_MS = 3_600_000;

/**
 * The real idempotency store (ADR 0003). The key row is inserted first, in
 * the same short transaction as the case writes. A concurrent request with
 * the same key blocks on the primary key until the first commits, then finds
 * the row and returns its stored answer; if the first rolls back, the waiter
 * goes on as if it were alone.
 */
export function createPostgresIdempotencyStore(deps: {
  db: Kysely<Database>;
  clock: Clock;
  retentionHours: number;
}): IdempotencyStore {
  const { db, clock, retentionHours } = deps;

  async function lookup(source: SourceSystemId, key: IdempotencyKey): Promise<StoredKey | undefined> {
    const row = await db
      .selectFrom('idempotency_key')
      .select(['fingerprint', 'response'])
      .where('source_system_id', '=', source)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      // Stored by `record` from a Fingerprint.
      fingerprint: row.fingerprint as Fingerprint,
      response: ingestResponseSchema.parse(row.response),
    };
  }

  return {
    lookup,

    async record(source, key, fingerprint, accept) {
      try {
        const accepted = await db.transaction().execute(async (trx): Promise<IngestResponse> => {
          const claimed = await trx
            .insertInto('idempotency_key')
            .values({ source_system_id: source, key, fingerprint, response: null, created_at: clock() })
            .onConflict((oc) => oc.constraint('idempotency_key_pkey').doNothing())
            .returning('key')
            .executeTakeFirst();
          if (!claimed) throw new KeyTaken();

          const response = await accept(trx);
          await trx
            .updateTable('idempotency_key')
            .set({ response: JSON.stringify(response) })
            .where('source_system_id', '=', source)
            .where('key', '=', key)
            .execute();
          return response;
        });
        return { accepted };
      } catch (err) {
        if (!(err instanceof KeyTaken)) throw err;
        const winner = await lookup(source, key);
        if (!winner) throw new Error(`idempotency key of source ${source} vanished right after a conflict`, { cause: err });
        return { raced: winner };
      }
    },

    async purgeExpired() {
      const cutoff = new Date(clock().getTime() - retentionHours * HOUR_MS);
      const result = await db.deleteFrom('idempotency_key').where('created_at', '<', cutoff).executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
