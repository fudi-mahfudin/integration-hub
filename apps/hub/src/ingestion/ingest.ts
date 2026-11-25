import type { Redis } from 'ioredis';
import type { Kysely, Transaction } from 'kysely';
import type { SourceSystem } from '../auth/source-systems.js';
import { recordEvent } from '../cases/record-event.js';
import type { HubConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import type { Clock } from '../tokens.js';
import { EVENT_TYPES, type EventType } from '../cases/case-model.js';
import { MAX_VISIT_ID_LENGTH, parseBody, validateEvent, type ParsedBody, type ValidatedEvent } from './event-schema.js';
import { fingerprint } from './fingerprint.js';
import { createNaiveRedisStore } from './naive-redis-store.js';
import { createPostgresStore } from './postgres-store.js';

/** A stored, replayable ingest answer. `body` is kept as sent, so a replay is byte-for-byte. */
export interface IngestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** What a key lookup finds: the fingerprint it was accepted with and the answer given. */
export interface StoredKey {
  fingerprint: string;
  response: IngestResponse;
}

/**
 * Where accepted idempotency keys live. `record` runs `accept` (the case
 * writes) in one transaction and remembers the key with its answer; the two
 * implementations differ only in how they guard that against a race.
 */
export interface IdempotencyStore {
  lookup(source: SourceSystem, key: string): Promise<StoredKey | undefined>;
  /**
   * Resolves to the new answer, or to `{ raced }` when a concurrent request
   * with the same key committed first (the caller then replays its answer).
   */
  record(
    source: SourceSystem,
    key: string,
    fingerprint: string,
    accept: (trx: Transaction<Database>) => Promise<IngestResponse>,
  ): Promise<IngestResponse | { raced: StoredKey }>;
  purgeExpired(): Promise<number>;
}

export interface Ingest {
  /** Key lookup, event schema, cross-event checks, accept (#7 check order). Rejections throw `Problem`. */
  accept(source: SourceSystem, idempotencyKey: string, rawBody: string): Promise<IngestResponse>;
  /** Deletes keys older than the retention window; resolves to how many. */
  purgeExpiredKeys(): Promise<number>;
}

export interface IngestDeps {
  config: HubConfig;
  db: Kysely<Database>;
  redis: Redis;
  clock: Clock;
}

export function createIngest(deps: IngestDeps): Ingest {
  const store =
    deps.config.idempotencyStore === 'naive-redis' ? createNaiveRedisStore(deps) : createPostgresStore(deps);

  return {
    async accept(source, key, rawBody) {
      const parsed = parseBody(rawBody);
      const print = fingerprint(rawBody, parsed);

      const known = await store.lookup(source, key);
      if (known) return replay(known, print);

      try {
        const event = validateEvent(parsed);
        const result = await store.record(source, key, print, (trx) => acceptEvent(trx, source, event, deps.clock()));
        return 'raced' in result ? replay(result.raced, print) : result;
      } catch (err) {
        // A key reused for another body is about the key, not the visit: not logged.
        if (err instanceof Problem && err.status < 500 && err.code !== 'IDEMPOTENCY_KEY_REUSED') await logRejection(deps.db, source, parsed, err.code, deps.clock());
        throw err;
      }
    },
    purgeExpiredKeys: () => store.purgeExpired(),
  };
}

/**
 * Records a rejected event against its (source, visitId), when the body names
 * one: code, event type and time, never the body (#8). It never changes state.
 */
async function logRejection(db: Kysely<Database>, source: SourceSystem, parsed: ParsedBody, code: string, now: Date): Promise<void> {
  const body = parsed.ok ? (parsed.value as Record<string, unknown> | null) : null;
  const visitId = typeof body === 'object' && body !== null ? body.visitId : undefined;
  if (typeof visitId !== 'string' || visitId.trim() === '' || visitId.length > MAX_VISIT_ID_LENGTH) return;
  const type = body?.type;
  await db
    .insertInto('ingest_rejection')
    .values({
      source_id: source.id,
      visit_id: visitId,
      code,
      event_type: EVENT_TYPES.includes(type as EventType) ? (type as EventType) : null,
      rejected_at: now,
    })
    .execute();
}

/** Same key and fingerprint: the original answer verbatim. Same key, other body: 422 (#7). */
function replay(known: StoredKey, print: string): IngestResponse {
  if (known.fingerprint !== print) throw new Problem(422, 'IDEMPOTENCY_KEY_REUSED');
  return { ...known.response, headers: { ...known.response.headers, 'idempotent-replayed': 'true' } };
}

async function acceptEvent(
  trx: Transaction<Database>,
  source: SourceSystem,
  event: ValidatedEvent,
  now: Date,
): Promise<IngestResponse> {
  const recorded = await recordEvent(trx, source, event, now);
  return {
    status: 202,
    headers: { 'content-type': 'application/json; charset=utf-8', location: `/v1/cases/${recorded.caseId}` },
    body: JSON.stringify({ visitId: event.visitId, type: event.type, caseStatus: recorded.caseStatus }),
  };
}
