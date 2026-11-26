// The thin typed client for the mock's inspection and control API. Tests,
// the source simulator and the big-run harness talk to the mock only through
// this and the SATUSEHAT-facing paths, never through its internals.
import { z } from 'zod';
import type { FaultRulesInput } from './faults.js';
import type { Hold } from './parking.js';
import { RECORD_TYPES, type RecordType } from './platform.js';
import type { MockReport } from './report.js';
import type { LogEntry, LogQuery } from './submission-log.js';
import type { WorldEntries } from './world/world.js';

export type { FaultRulesInput } from './faults.js';
export type { Hold } from './parking.js';
export type { RecordType } from './platform.js';
export type { DuplicateSubmission, MockReport, OutOfOrderEffect, OverlappingRequests } from './report.js';
export type { Effect, LogEntry, LogQuery } from './submission-log.js';
export type { WorldEntries } from './world/world.js';

const logEntrySchema = z.object({
  seq: z.number().int(),
  receivedAt: z.string(),
  respondedAt: z.string(),
  method: z.string(),
  path: z.string(),
  resourceType: z.string().nullable(),
  visitKey: z.string().nullable(),
  businessIdentifier: z.string().nullable(),
  request: z.object({ body: z.unknown() }),
  response: z.object({ status: z.number().int().nullable(), body: z.unknown() }),
  fault: z.string().nullable(),
  effect: z.enum(['created', 'updated', 'none', 'admin']),
}) satisfies z.ZodType<LogEntry>;

const reportSchema = z.object({
  faultSeed: z.number().nullable(),
  duplicates: z.array(
    z.object({ resourceType: z.string(), effect: z.enum(['created', 'updated']), businessIdentifier: z.string(), visitKey: z.string().nullable(), seqs: z.array(z.number()) }),
  ),
  outOfOrder: z.array(z.object({ visitKey: z.string(), seq: z.number(), effect: z.string(), reason: z.string() })),
  overlap: z.array(z.object({ visitKey: z.string(), seqs: z.tuple([z.number(), z.number()]) })),
}) satisfies z.ZodType<MockReport>;

const holdSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  method: z.string(),
  path: z.string(),
  resourceType: z.string().nullable(),
  visitKey: z.string().nullable(),
  businessIdentifier: z.string().nullable(),
  parkedAt: z.string(),
}) satisfies z.ZodType<Hold>;

const storedRecordSchema = z.looseObject({
  resourceType: z.enum(RECORD_TYPES),
  id: z.string(),
  meta: z.looseObject({ versionId: z.string() }),
});

/** A record as the mock holds it after a direct insert or patch. */
export type StoredRecord = z.infer<typeof storedRecordSchema>;

/** Thrown when the mock answers a control request with an unexpected status. */
export class MockRequestError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`mock ${path} answered ${status}, expected 2xx: ${body}`);
    this.name = 'MockRequestError';
  }
}

/** Seedable entries; every list is optional. */
export type SeedEntries = Partial<WorldEntries>;

/** Typed access to `/__mock/*` on one mock SATUSEHAT. */
export class MockSatusehatClient {
  /** @param baseUrl where the mock listens, e.g. `http://127.0.0.1:41234/` */
  constructor(private readonly baseUrl: URL) {}

  /** Submission log entries matching the query, oldest first. */
  async log(query: LogQuery = {}): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== undefined) params.set(name, String(value));
    const res = await this.request('GET', `__mock/log?${params}`);
    return z.object({ entries: z.array(logEntrySchema) }).parse(await res.json()).entries;
  }

  /** The whole submission log from `GET /__mock/log.ndjson`. */
  async logNdjson(): Promise<LogEntry[]> {
    const res = await this.request('GET', '__mock/log.ndjson');
    const text = await res.text();
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => logEntrySchema.parse(JSON.parse(line)));
  }

  /** Invariant violations computed from the log; empty sections mean every invariant held. */
  async report(): Promise<MockReport> {
    const res = await this.request('GET', '__mock/report');
    return reportSchema.parse(await res.json());
  }

  /** Clears records, log, tokens and throttle state, then reloads the world dataset. */
  async reset(): Promise<void> {
    await this.request('POST', '__mock/reset');
  }

  /** Adds entries to the world until the next reset. */
  async seed(entries: SeedEntries): Promise<void> {
    await this.request('POST', '__mock/seed', entries);
  }

  /** Replaces the fault rules; the same seed and rules give the same faults on the same requests. */
  async setFaults(rules: FaultRulesInput): Promise<void> {
    await this.request('PUT', '__mock/faults', rules);
  }

  /**
   * The requests hold faults have parked, oldest first. When none is parked,
   * waits up to `waitMs` for one, so a test learns the moment a request
   * arrives without sleeping.
   */
  async holds(waitMs: number): Promise<Hold[]> {
    const res = await this.request('GET', `__mock/holds?wait=${waitMs}`);
    return z.object({ holds: z.array(holdSchema) }).parse(await res.json()).holds;
  }

  /** Lets the request parked under hold `id` go on to be applied and answered. */
  async releaseHold(id: string): Promise<void> {
    await this.request('POST', `__mock/holds/${encodeURIComponent(id)}/release`);
  }

  /** Deletes a stored record behind the hub's back: later searches miss it and a PUT of it gets 404. */
  async deleteRecord(type: RecordType, id: string): Promise<void> {
    await this.request('DELETE', `__mock/records/${type}/${encodeURIComponent(id)}`);
  }

  /** Changes a stored record behind the hub's back with a JSON merge patch; bumps its `meta.versionId`. */
  async patchRecord(type: RecordType, id: string, patch: Record<string, unknown>): Promise<StoredRecord> {
    const res = await this.request('PATCH', `__mock/records/${type}/${encodeURIComponent(id)}`, patch, 'application/merge-patch+json');
    return storedRecordSchema.parse(await res.json());
  }

  /** Stores a record directly, unvalidated, as if someone else had created it at the platform. */
  async insertRecord(record: Record<string, unknown>): Promise<StoredRecord> {
    const res = await this.request('POST', '__mock/records', record);
    return storedRecordSchema.parse(await res.json());
  }

  /** Invalidates every issued access token. */
  async revokeTokens(): Promise<void> {
    await this.request('POST', '__mock/tokens/revoke');
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<Response> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': contentType }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new MockRequestError(path.split('?')[0] ?? path, res.status, await res.text());
    return res;
  }
}
