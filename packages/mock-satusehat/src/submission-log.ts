/** What a request did to the mock's records. Rejected and faulted-before-apply requests are `none`. */
export type Effect = 'created' | 'updated' | 'none';

/** One request the mock received, with what it answered and what it changed. */
export interface LogEntry {
  /** Global, monotonic, starting at 1 after each reset. */
  seq: number;
  /** ISO-8601 UTC. */
  receivedAt: string;
  /** ISO-8601 UTC. */
  respondedAt: string;
  method: string;
  /** Path and query string as received. */
  path: string;
  /** FHIR resource type the request addressed, or null (token endpoint, unknown paths). */
  resourceType: string | null;
  /** The visit's `encounter/{org}` identifier value, when the request is about one visit. */
  visitKey: string | null;
  /** `{system}|{value}` of the record the request created or searched for. */
  businessIdentifier: string | null;
  /** The request body as parsed; secrets (client_secret) are left out. */
  request: { body: unknown };
  response: { status: number; body: unknown };
  /** Id of the fault rule that hit this request, or null. */
  fault: string | null;
  effect: Effect;
}

/** Filter for `GET /__mock/log`. */
export interface LogQuery {
  visitKey?: string;
  resourceType?: string;
  /** Only entries with a larger `seq`. */
  afterSeq?: number;
  /** At most this many entries, oldest first. */
  limit?: number;
}

/** The in-memory submission log. Appending assigns `seq`, so log order is seq order. */
export class SubmissionLog {
  private entries: LogEntry[] = [];

  /** Records one request and returns it with its `seq`. */
  append(entry: Omit<LogEntry, 'seq'>): LogEntry {
    const logged = { seq: this.entries.length + 1, ...entry };
    this.entries.push(logged);
    return logged;
  }

  /** Entries matching every given filter, in seq order. */
  query(query: LogQuery): LogEntry[] {
    const matching = this.entries.filter(
      (e) =>
        (query.visitKey === undefined || e.visitKey === query.visitKey) &&
        (query.resourceType === undefined || e.resourceType === query.resourceType) &&
        (query.afterSeq === undefined || e.seq > query.afterSeq),
    );
    return query.limit === undefined ? matching : matching.slice(0, query.limit);
  }

  /** Every entry, in seq order. */
  all(): readonly LogEntry[] {
    return this.entries;
  }

  /** Empties the log; the next entry gets seq 1. */
  clear(): void {
    this.entries = [];
  }
}
