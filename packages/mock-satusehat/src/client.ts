import type { Resource } from 'fhir/r4.js';
import type { FaultConfig } from './faults.js';
import type { HoldInfo } from './holds.js';
import type { LogEntry, LogQuery, Report } from './log.js';
import type { WorldSeed } from './world/world.js';

/**
 * Thin typed client for the mock's inspection and control API (`/__mock/*`).
 * The only way tests, the simulator and the big run touch the mock beyond the
 * platform surface itself.
 */
export class MockClient {
  constructor(readonly baseUrl: string) {}

  /** Clears records, log, tokens and throttle state, then reloads the world. */
  async reset(): Promise<void> {
    await this.send('POST', '/__mock/reset');
  }

  /** Adds world entries that live until the next reset. */
  async seed(entries: WorldSeed): Promise<void> {
    await this.send('POST', '/__mock/seed', entries);
  }

  /** Invalidates every issued token; the next FHIR call gets 401. */
  async revokeTokens(): Promise<void> {
    await this.send('POST', '/__mock/tokens/revoke');
  }

  /** Replaces every fault rule and restarts their request counters. */
  async setFaults(config: FaultConfig): Promise<void> {
    await this.send('PUT', '/__mock/faults', config);
  }

  async clearFaults(): Promise<void> {
    await this.send('PUT', '/__mock/faults', { seed: 0, rules: [] });
  }

  /** Parked requests; long-polls up to `waitMs` until there is at least one. */
  async holds(waitMs = 0): Promise<HoldInfo[]> {
    return (await this.send('GET', `/__mock/holds?wait=${waitMs}`)) as HoldInfo[];
  }

  /** Waits (up to `waitMs`) for a parked request and returns it; throws if none arrives. */
  async nextHold(waitMs = 5_000): Promise<HoldInfo> {
    const [h] = await this.holds(waitMs);
    if (!h) throw new Error(`no request parked within ${waitMs}ms`);
    return h;
  }

  /** Lets a parked request carry on as if nothing happened. */
  async releaseHold(id: string): Promise<void> {
    await this.send('POST', `/__mock/holds/${encodeURIComponent(id)}/release`);
  }

  /** Removes a stored record: later reads and PUTs get 404. */
  async deleteRecord(type: string, id: string): Promise<void> {
    await this.send('DELETE', `/__mock/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
  }

  /** JSON merge patch on a stored record (a remote divergence); bumps `meta.versionId`. Returns the record. */
  async patchRecord<T extends Resource = Resource>(type: string, id: string, patch: unknown): Promise<T> {
    return (await this.send('PATCH', `/__mock/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, patch)) as T;
  }

  /** Stores a record directly ("remote but not local"); `id` and `meta` are assigned if absent. Returns the record. */
  async insertRecord<T extends Resource>(resource: T): Promise<T> {
    return (await this.send('POST', '/__mock/records', resource)) as T;
  }

  async log(query: LogQuery = {}): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.size > 0 ? `?${params}` : '';
    return (await this.send('GET', `/__mock/log${qs}`)) as LogEntry[];
  }

  /** The whole log, as streamed by `GET /__mock/log.ndjson`. */
  async logNdjson(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/__mock/log.ndjson`);
    if (!res.ok) throw new Error(`GET /__mock/log.ndjson -> ${res.status}`);
    return res.text();
  }

  async report(): Promise<Report> {
    return (await this.send('GET', '/__mock/report')) as Report;
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return text === '' ? undefined : JSON.parse(text);
  }
}
