/** One logged request (#12). Shared by the server and the typed client. */
export interface LogEntry {
  /** Global, monotonic; assigned when the response is sent, so `afterSeq` paging never skips. */
  seq: number;
  kind: 'platform' | 'admin';
  receivedAt: string;
  respondedAt: string;
  method: string;
  path: string;
  resourceType: string | null;
  /** The `encounter/{org}` identifier value of the visit this request touches. */
  visitKey: string | null;
  /** `system|value` of the record's business identifier. */
  businessIdentifier: string | null;
  request: { query: Record<string, string>; body: unknown };
  response: { status: number; body: unknown };
  /** Fault rule id, or null. */
  fault: string | null;
  effect: 'created' | 'updated' | 'none';
}

export interface LogQuery {
  visitKey?: string;
  resourceType?: string;
  afterSeq?: number;
  limit?: number;
}

export interface Report {
  faultSeed: number | null;
  duplicateSubmissions: {
    resourceType: string;
    /** Business identifier for creates; visit key for update-visit PUTs. */
    key: string;
    effect: 'created' | 'updated';
    seqs: number[];
  }[];
  outOfOrderEffects: {
    visitKey: string;
    /** The effect that arrived after a later-stage effect. */
    seq: number;
    effect: string;
    after: { seq: number; effect: string };
  }[];
  overlappingInFlight: {
    visitKey: string;
    seqs: [number, number];
  }[];
}
