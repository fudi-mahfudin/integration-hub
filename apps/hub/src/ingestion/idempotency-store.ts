import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Brand } from '../brand.js';
import type { Database } from '../db/database.js';
import type { Fingerprint } from './fingerprint.js';

/** The value of a request's `Idempotency-Key` header: opaque, 1-255 characters (#6). */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

/** The answer to an accepted event, stored with its key so a duplicate ingest gets it verbatim. */
export interface IngestResponse {
  status: number;
  headers: Record<string, string>;
  /** The body exactly as first sent. */
  body: string;
}

/** Parses a stored answer read back from a store (data crossing a boundary). */
export const ingestResponseSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

/** What a key lookup finds: the fingerprint the key was accepted with, and the answer given. */
export interface StoredKey {
  fingerprint: Fingerprint;
  response: IngestResponse;
}

/** Runs the case writes of an accepted event inside the store's transaction and returns the answer. */
export type AcceptInTransaction = (trx: Transaction<Database>) => Promise<IngestResponse>;

/**
 * Where accepted idempotency keys live. Both implementations record the key
 * with its answer only when `accept` succeeds, so only an accepted event
 * consumes a key (#7); they differ in whether that holds under a race.
 */
export interface IdempotencyStore {
  /** The key as accepted earlier, or `undefined` if it is unknown (never used, or purged). */
  lookup(source: SourceSystemId, key: IdempotencyKey): Promise<StoredKey | undefined>;
  /**
   * Runs `accept` in one transaction and records the key with its answer.
   * Resolves to `{ accepted }`, or to `{ raced }` when a concurrent request
   * with the same key committed first.
   */
  record(
    source: SourceSystemId,
    key: IdempotencyKey,
    fingerprint: Fingerprint,
    accept: AcceptInTransaction,
  ): Promise<{ accepted: IngestResponse } | { raced: StoredKey }>;
  /** Deletes keys older than the retention window; resolves to how many it deleted. */
  purgeExpired(): Promise<number>;
}
