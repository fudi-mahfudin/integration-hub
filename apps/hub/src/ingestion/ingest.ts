import type { Kysely } from 'kysely';
import type { SourceSystem } from '../auth/source-systems.js';
import type { Clock } from '../clock.js';
import { recordEvent, type AcceptedEvent, type RecordedEvent } from '../cases/record-event.js';
import { logRejection, type RejectionCode } from '../cases/rejection-log.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import { log } from '../observability/log.js';
import { parseEvent, rejectedEventOf } from './event-schema.js';
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

/** The rejections that judged a visit's event, and so go to its rejection log (#8). */
const LOGGED_REJECTIONS: ReadonlySet<string> = new Set<RejectionCode>(['VALIDATION_FAILED', 'UNSUPPORTED_MULTI_ITEM', 'EVENT_ALREADY_RECORDED']);

/** Builds ingest over an idempotency store and the hub database (for the rejection log). Only the composition root calls this. */
export function createIngest(deps: { store: IdempotencyStore; db: Kysely<Database>; clock: Clock }): Ingest {
  const { store, db, clock } = deps;

  async function accept(source: SourceSystem, key: IdempotencyKey, body: RequestBody): Promise<IngestResponse> {
    const bodyFingerprint = fingerprint(body);

    const known = await store.lookup(source.id, key);
    if (known) return answerDuplicate(known, bodyFingerprint);

    const event = await parseEventAfterKeyLookup(store, source, key, body, bodyFingerprint);
    const result = await store.record(source.id, key, bodyFingerprint, (trx) =>
      recordEvent(trx, source, event, clock()).then((recorded) => accepted(event, recorded)),
    );
    return 'accepted' in result ? result.accepted : answerDuplicate(result.raced, bodyFingerprint);
  }

  /** Logs a rejection of a visit's event, when the body names the visit and the event type. */
  async function noteRejection(source: SourceSystem, body: RequestBody, code: RejectionCode): Promise<void> {
    const rejected = rejectedEventOf(body);
    if (!rejected) return;
    try {
      await logRejection(db, { sourceSystemId: source.id, ...rejected }, code, clock());
    } catch (err) {
      // The log only explains a waiting case; the source still gets its answer, and no case changed.
      log('error', 'logging an ingest rejection failed', { code, eventType: rejected.eventType, error: err });
    }
  }

  return {
    async ingest(source, key, rawBody) {
      const body = readBody(rawBody);
      try {
        return await accept(source, key, body);
      } catch (err) {
        if (err instanceof Problem && LOGGED_REJECTIONS.has(err.code)) {
          // Checked just above: the code is one of the logged rejection codes.
          await noteRejection(source, body, err.code as RejectionCode);
        }
        throw err;
      }
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
