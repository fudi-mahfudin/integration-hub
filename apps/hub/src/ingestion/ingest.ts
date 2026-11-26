import type { SourceSystem } from '../auth/source-systems.js';
import type { Clock } from '../clock.js';
import { recordEvent, type AcceptedEvent, type RecordedEvent } from '../cases/record-event.js';
import { Problem } from '../http/problem.js';
import { parseEvent } from './event-schema.js';
import { fingerprint, type Fingerprint, type RequestBody } from './fingerprint.js';
import type { IdempotencyKey, IdempotencyStore, IngestResponse, StoredKey } from './idempotency-store.js';

/** Ingest of source events, after authentication and the `Idempotency-Key` header check. */
export interface Ingest {
  /**
   * Key lookup → event schema → cross-event checks → accept (#7 check order).
   * Resolves to the answer to send; rejections throw `Problem`.
   */
  ingest(source: SourceSystem, key: IdempotencyKey, rawBody: string): Promise<IngestResponse>;
  /** Deletes idempotency keys older than the retention window; resolves to how many. */
  purgeExpiredKeys(): Promise<number>;
}

/** Builds ingest over an idempotency store. Only the composition root calls this. */
export function createIngest(deps: { store: IdempotencyStore; clock: Clock }): Ingest {
  const { store, clock } = deps;
  return {
    async ingest(source, key, rawBody) {
      const body = readBody(rawBody);
      const bodyFingerprint = fingerprint(body);

      const known = await store.lookup(source.id, key);
      if (known) return answerDuplicate(known, bodyFingerprint);

      const event = await parseEventAfterKeyLookup(store, source, key, body, bodyFingerprint);
      const result = await store.record(source.id, key, bodyFingerprint, (trx) =>
        recordEvent(trx, source, event, clock()).then((recorded) => accepted(event, recorded)),
      );
      return 'accepted' in result ? result.accepted : answerDuplicate(result.raced, bodyFingerprint);
    },
    purgeExpiredKeys: () => store.purgeExpired(),
  };
}

/**
 * The schema check, keeping the #7 check order under a race: if the body is
 * invalid but a concurrent request accepted the same key since the first
 * lookup, the key answer (`IDEMPOTENCY_KEY_REUSED`) wins over `VALIDATION_FAILED`.
 */
async function parseEventAfterKeyLookup(
  store: IdempotencyStore,
  source: SourceSystem,
  key: IdempotencyKey,
  body: RequestBody,
  bodyFingerprint: Fingerprint,
): Promise<AcceptedEvent> {
  try {
    return parseEvent(body);
  } catch (err) {
    if (!(err instanceof Problem)) throw err;
    const known = await store.lookup(source.id, key);
    if (known) answerDuplicate(known, bodyFingerprint);
    throw err;
  }
}

function readBody(rawBody: string): RequestBody {
  try {
    const value: unknown = JSON.parse(rawBody);
    return { json: true, value };
  } catch {
    // Not JSON: fingerprinted as raw text, then rejected by the schema.
    return { json: false, text: rawBody };
  }
}

/**
 * A duplicate ingest gets the original status and body verbatim, flagged with
 * `Idempotent-Replayed: true` (the header's name comes from the IETF draft);
 * the same key with another body is rejected (#7).
 */
function answerDuplicate(known: StoredKey, bodyFingerprint: Fingerprint): IngestResponse {
  if (known.fingerprint !== bodyFingerprint) throw new Problem('IDEMPOTENCY_KEY_REUSED', []);
  return { ...known.response, headers: { ...known.response.headers, 'idempotent-replayed': 'true' } };
}

function accepted(event: AcceptedEvent, recorded: RecordedEvent): IngestResponse {
  return {
    status: 202,
    headers: { 'content-type': 'application/json; charset=utf-8', location: `/v1/cases/${recorded.caseId}` },
    body: JSON.stringify({ visitId: event.visitId, type: event.type, caseStatus: recorded.caseStatus }),
  };
}
