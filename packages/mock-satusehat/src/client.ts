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
