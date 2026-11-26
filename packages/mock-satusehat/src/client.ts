// The thin typed client for the mock's inspection and control API. Tests,
// the source simulator and the big-run harness talk to the mock only through
// this and the SATUSEHAT-facing paths, never through its internals.
import type { MockReport } from './report.js';
import type { LogEntry, LogQuery } from './submission-log.js';
import type { WorldEntries } from './world/world.js';

export type { DuplicateSubmission, MockReport, OutOfOrderEffect, OverlappingRequests } from './report.js';
export type { Effect, LogEntry, LogQuery } from './submission-log.js';
export type { WorldEntries } from './world/world.js';

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
    // The mock serves this shape; the client and server ship in one package.
    return ((await res.json()) as { entries: LogEntry[] }).entries;
  }

  /** The whole submission log from `GET /__mock/log.ndjson`. */
  async logNdjson(): Promise<LogEntry[]> {
    const res = await this.request('GET', '__mock/log.ndjson');
    const text = await res.text();
    // One LogEntry per line, written by the same package.
    return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as LogEntry);
  }

  /** Invariant violations computed from the log; empty sections mean every invariant held. */
  async report(): Promise<MockReport> {
    const res = await this.request('GET', '__mock/report');
    // Same-package server shape.
    return (await res.json()) as MockReport;
  }

  /** Clears records, log, tokens and throttle state, then reloads the world dataset. */
  async reset(): Promise<void> {
    await this.request('POST', '__mock/reset');
  }

  /** Adds entries to the world until the next reset. */
  async seed(entries: SeedEntries): Promise<void> {
    await this.request('POST', '__mock/seed', entries);
  }

  /** Invalidates every issued access token. */
  async revokeTokens(): Promise<void> {
    await this.request('POST', '__mock/tokens/revoke');
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new MockRequestError(path.split('?')[0] ?? path, res.status, await res.text());
    return res;
  }
}
