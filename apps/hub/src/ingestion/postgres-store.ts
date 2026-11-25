import type { SourceSystem } from '../auth/source-systems.js';
import type { IdempotencyStore, IngestDeps, IngestResponse, StoredKey } from './ingest.js';

/** Thrown inside the transaction to roll it back when another request owns the key. */
class KeyTaken extends Error {}

/**
 * The real store (ADR 0003): the key row is inserted first in the same short
 * transaction as the case writes. A concurrent request with the same key
 * blocks on the primary key until the first commits, then sees the row and
 * returns its stored answer; if the first rolls back, the waiter proceeds as if alone.
 */
export function createPostgresStore({ db, clock, config }: IngestDeps): IdempotencyStore {
  const lookup = async (source: SourceSystem, key: string): Promise<StoredKey | undefined> => {
    const row = await db
      .selectFrom('idempotency_key')
      .select(['fingerprint', 'response_status', 'response_headers', 'response_body'])
      .where('source_id', '=', source.id)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.response_status === null || row.response_body === null) {
      throw new Error('idempotency key row without a response outside its transaction');
    }
    return {
      fingerprint: row.fingerprint,
      response: { status: row.response_status, headers: row.response_headers ?? {}, body: row.response_body },
    };
  };

  return {
    lookup,

    async record(source, key, fingerprint, accept) {
      try {
        return await db.transaction().execute(async (trx): Promise<IngestResponse> => {
          const claimed = await trx
            .insertInto('idempotency_key')
            .values({ source_id: source.id, key, fingerprint, created_at: clock() })
            .onConflict((oc) => oc.constraint('idempotency_key_pkey').doNothing())
            .returning('key')
            .executeTakeFirst();
          if (!claimed) throw new KeyTaken();

          const response = await accept(trx);
          await trx
            .updateTable('idempotency_key')
            .set({
              response_status: response.status,
              response_headers: JSON.stringify(response.headers),
              response_body: response.body,
            })
            .where('source_id', '=', source.id)
            .where('key', '=', key)
            .execute();
          return response;
        });
      } catch (err) {
        if (!(err instanceof KeyTaken)) throw err;
        const winner = await lookup(source, key);
        if (!winner) throw new Error('idempotency key vanished after a conflict', { cause: err });
        return { raced: winner };
      }
    },

    async purgeExpired() {
      const cutoff = new Date(clock().getTime() - config.idempotencyRetentionHours * 3_600_000);
      const result = await db.deleteFrom('idempotency_key').where('created_at', '<', cutoff).executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

