import type { Kysely } from 'kysely';
import type { SourceSystem } from '../auth/source-systems.js';
import type { Clock } from '../clock.js';
import type { CaseId } from '../cases/case-model.js';
import { countDuplicate, recordEvent, type AcceptedEvent, type RecordedEvent } from '../cases/record-event.js';
import { isLoggedRejection, logRejection, type RejectionCode } from '../cases/rejection-log.js';
import type { Database } from '../db/database.js';
import { Problem } from '../http/problem.js';
import { addToRequestContext, type Log } from '../observability/log.js';
import type { HubMetrics } from '../observability/metrics.js';
import { activeTraceparent, annotateActiveSpan, inSpan } from '../observability/tracing.js';
import { parseEvent, visitEventOf } from './event-schema.js';
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

/** Builds ingest over an idempotency store and the hub database (for the rejection log). Only the composition root calls this. */
export function createIngest(deps: {
  store: IdempotencyStore;
  db: Kysely<Database>;
  clock: Clock;
  log: Log;
  metrics: Pick<HubMetrics, 'ingestDuplicate'>;
}): Ingest {
  const { store, db, clock, log, metrics } = deps;

  async function accept(source: SourceSystem, key: IdempotencyKey, body: RequestBody): Promise<IngestResponse> {
    const bodyFingerprint = fingerprint(body);

    const known = await store.lookup(source.id, key);
    if (known) return countedDuplicate(source, body, answerDuplicate(known, bodyFingerprint));

    const event = await parseEventAfterKeyLookup(store, source, key, body, bodyFingerprint);
    let caseId: CaseId | undefined;
    // The ingest span (#15): the accepting transaction. The event keeps its traceparent, so its step's attempts join this trace.
    const result = await inSpan('ingest.accept', { 'event.type': event.type }, async (span) => {
      const traceparent = activeTraceparent();
      const recorded = await store.record(source.id, key, bodyFingerprint, (trx) =>
        recordEvent(trx, source, event, clock(), traceparent).then((r) => {
          caseId = r.caseId;
          return accepted(event, r);
        }),
      );
      if (caseId !== undefined && 'accepted' in recorded) span.setAttribute('case.id', caseId);
      return recorded;
    });
    if (!('accepted' in result)) return countedDuplicate(source, body, answerDuplicate(result.raced, bodyFingerprint));
    // The request's server span too.
    if (caseId !== undefined) annotateActiveSpan({ 'case.id': caseId });
    log('info', 'source event accepted', { caseId });
    return result.accepted;
  }

  /** Counts a duplicate ingest against the event it duplicates, then answers it. */
  async function countedDuplicate(source: SourceSystem, body: RequestBody, answer: IngestResponse): Promise<IngestResponse> {
    // The body has the fingerprint of an accepted event, so it names that event's visit and type.
    const named = visitEventOf(body);
    if (!named) throw new Error('a duplicate of an accepted event does not name a visit and event type');
    try {
      await countDuplicate(db, { sourceSystemId: source.id, ...named });
    } catch (err) {
      // The count only informs the case view; the source still gets its original answer, and no case changed.
      log('error', 'counting a duplicate ingest failed', { error: err });
    }
    metrics.ingestDuplicate(named.eventType);
    log('info', 'duplicate ingest; the original answer is sent again');
    return answer;
  }

  /** Logs a rejection of a visit's event, when the body names the visit and the event type. */
  async function noteRejection(source: SourceSystem, body: RequestBody, code: RejectionCode): Promise<void> {
    const rejected = visitEventOf(body);
    if (!rejected) return;
    try {
      await logRejection(db, { sourceSystemId: source.id, ...rejected }, code, clock());
    } catch (err) {
      // The log only explains a waiting case; the source still gets its answer, and no case changed.
      log('error', 'logging an ingest rejection failed', { errorCode: code, error: err });
    }
  }

  return {
    async ingest(source, key, rawBody) {
      const body = readBody(rawBody);
      const named = visitEventOf(body);
      addToRequestContext({ source: source.id, ...(named === undefined ? {} : { eventType: named.eventType }) });
      try {
        return await accept(source, key, body);
      } catch (err) {
        const { code } = err instanceof Problem ? err : { code: undefined };
        if (code !== undefined && isLoggedRejection(code)) await noteRejection(source, body, code);
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
