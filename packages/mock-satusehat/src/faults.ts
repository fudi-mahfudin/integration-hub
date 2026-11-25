import { createHash } from 'node:crypto';

/** Fault kinds (#12). `*_after_apply` apply the request first; `latency` and `hold` delay it, then let it through. */
export const FAULT_KINDS = [
  'http_500',
  'http_503',
  'http_429',
  'http_400',
  'http_401',
  'timeout',
  'connection_reset',
  'timeout_after_apply',
  'http_500_after_apply',
  'latency',
  'hold',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export interface FaultParams {
  /** http_503 / http_429: number = seconds (or an HTTP date that many seconds from now, see `retryAfterFormat`); string = sent verbatim. Absent = no header. */
  retryAfter?: number | string;
  retryAfterFormat?: 'seconds' | 'http-date';
  /** latency: fixed delay. timeout / timeout_after_apply: max hold before dropping (default 30s); the drop happens earlier if the client hangs up. */
  ms?: number;
  /** latency: uniform range, drawn deterministically like the fault decision. */
  minMs?: number;
  maxMs?: number;
  /** http_400: rule code in the OperationOutcome (default `FAULT_INJECTED`) and its step code (default `PAYLOAD_INVALID`). */
  rule?: string;
  code?: string;
}

export interface FaultRule {
  id: string;
  /** All given fields must match. `path` is the exact pathname, or a prefix when it ends with `*`. */
  match: { method?: string; resourceType?: string; path?: string };
  kind: FaultKind;
  /** Exactly one of these: probability 0..1, every Nth request, or the first N requests (per identifier). */
  rate?: number;
  everyNth?: number;
  firstN?: number;
  params?: FaultParams;
}

export interface FaultConfig {
  seed: number;
  rules: FaultRule[];
}

/** What the engine needs to know about a request. `key` is its business identifier (or a stable fallback). */
export interface FaultRequest {
  method: string;
  path: string;
  resourceType: string | null;
  key: string;
}

export interface FaultDecision {
  /** Delays applied first, in rule order. */
  delays: { rule: FaultRule; ms?: number }[];
  /** The first terminal rule that fired, if any. */
  terminal: FaultRule | null;
}

const DELAY_KINDS: ReadonlySet<FaultKind> = new Set(['latency', 'hold']);

/**
 * The fault decision for one request (#12): a pure hash of
 * (seed, rule id, method, business identifier, nth), mapped to [0, 1).
 * `salt` separates independent draws for the same request (e.g. latency).
 */
export function faultDraw(seed: number, ruleId: string, method: string, key: string, nth: number, salt = ''): number {
  const digest = createHash('sha256').update(JSON.stringify([seed, ruleId, method.toUpperCase(), key, nth, salt])).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** Returns a list of problems; empty means valid. */
export function validateFaultConfig(body: unknown): string[] {
  const errors: string[] = [];
  const c = body as Partial<FaultConfig> | null;
  if (c === null || typeof c !== 'object') return ['body must be an object'];
  if (typeof c.seed !== 'number' || !Number.isInteger(c.seed)) errors.push('seed must be an integer');
  if (!Array.isArray(c.rules)) return [...errors, 'rules must be an array'];
  const ids = new Set<string>();
  c.rules.forEach((r, i) => {
    const at = `rules[${i}]`;
    if (typeof r?.id !== 'string' || r.id === '') errors.push(`${at}.id must be a non-empty string`);
    else if (ids.has(r.id)) errors.push(`${at}.id ${r.id} is not unique`);
    else ids.add(r.id);
    if (!FAULT_KINDS.includes(r?.kind)) errors.push(`${at}.kind must be one of ${FAULT_KINDS.join(', ')}`);
    if (r?.match === null || typeof r?.match !== 'object') errors.push(`${at}.match must be an object`);
    const modes = (['rate', 'everyNth', 'firstN'] as const).filter((m) => r?.[m] !== undefined);
    if (modes.length !== 1) errors.push(`${at} needs exactly one of rate, everyNth, firstN`);
    if (r?.rate !== undefined && !(typeof r.rate === 'number' && r.rate >= 0 && r.rate <= 1)) errors.push(`${at}.rate must be in [0, 1]`);
    for (const m of ['everyNth', 'firstN'] as const) {
      const v = r?.[m];
      if (v !== undefined && !(Number.isInteger(v) && v >= (m === 'everyNth' ? 1 : 0))) errors.push(`${at}.${m} must be a positive integer`);
    }
    const p = r?.params ?? {};
    if (r?.kind === 'latency' && p.ms === undefined && (p.minMs === undefined || p.maxMs === undefined || p.minMs > p.maxMs)) {
      errors.push(`${at}.params needs ms, or minMs <= maxMs`);
    }
  });
  return errors;
}

/** Fault rules plus the per-(rule, method, identifier) request counters. */
export class FaultEngine {
  private config: FaultConfig | null = null;
  private counters = new Map<string, number>();

  get seed(): number | null {
    return this.config?.seed ?? null;
  }

  configure(config: FaultConfig): void {
    this.config = config;
    this.counters.clear();
  }

  clear(): void {
    this.config = null;
    this.counters.clear();
  }

  /**
   * Rules are checked in order. Every matching rule counts the request; a
   * delay rule that fires is collected and checking goes on; the first
   * terminal rule that fires ends it. So a rule's `rate` is conditional on
   * the terminal rules before it not firing.
   */
  decide(req: FaultRequest): FaultDecision {
    const decision: FaultDecision = { delays: [], terminal: null };
    if (this.config === null) return decision;
    const { seed } = this.config;
    for (const rule of this.config.rules) {
      if (!matches(rule, req)) continue;
      const counter = `${rule.id}\u0000${req.method}\u0000${req.key}`;
      const nth = (this.counters.get(counter) ?? 0) + 1;
      this.counters.set(counter, nth);
      if (!fires(rule, seed, req, nth)) continue;
      if (DELAY_KINDS.has(rule.kind)) {
        decision.delays.push({ rule, ms: rule.kind === 'latency' ? latencyMs(rule, seed, req, nth) : undefined });
        continue;
      }
      decision.terminal = rule;
      break;
    }
    return decision;
  }
}

function matches(rule: FaultRule, req: FaultRequest): boolean {
  const m = rule.match;
  if (m.method !== undefined && m.method.toUpperCase() !== req.method.toUpperCase()) return false;
  if (m.resourceType !== undefined && m.resourceType !== req.resourceType) return false;
  if (m.path !== undefined) {
    if (m.path.endsWith('*') ? !req.path.startsWith(m.path.slice(0, -1)) : m.path !== req.path) return false;
  }
  return true;
}

function fires(rule: FaultRule, seed: number, req: FaultRequest, nth: number): boolean {
  if (rule.firstN !== undefined) return nth <= rule.firstN;
  if (rule.everyNth !== undefined) return nth % rule.everyNth === 0;
  return faultDraw(seed, rule.id, req.method, req.key, nth) < (rule.rate ?? 0);
}

function latencyMs(rule: FaultRule, seed: number, req: FaultRequest, nth: number): number {
  const p = rule.params ?? {};
  if (p.ms !== undefined) return p.ms;
  const lo = p.minMs ?? 0;
  const hi = p.maxMs ?? lo;
  return Math.round(lo + faultDraw(seed, rule.id, req.method, req.key, nth, 'latency') * (hi - lo));
}

/** `Retry-After` header for a 429/503 rule, or none. */
export function retryAfterHeader(params: FaultParams | undefined, now: number): Record<string, string> {
  const v = params?.retryAfter;
  if (v === undefined) return {};
  if (typeof v === 'string') return { 'retry-after': v };
  return { 'retry-after': params?.retryAfterFormat === 'http-date' ? new Date(now + v * 1000).toUTCString() : String(v) };
}
