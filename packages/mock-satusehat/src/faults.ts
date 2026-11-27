// Fault rules (GLOSSARY.md): what `PUT /__mock/faults` sets, and the decision
// of which rule, if any, hits a request. Every decision is a pure function of
// the seed, the rule, the request and how many requests came before it for
// the same identifier, so a run meets the same faults however workers
// interleave.
import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_HOLD_MS = 600_000;

const holdMs = z.number().int().min(0).max(MAX_HOLD_MS);
const noParams = z.object({}).strict().default({});
const retryAfterSchema = z
  .object({ form: z.enum(['seconds', 'http-date']), seconds: z.number().int().min(0).max(86_400) })
  .strict();
const throttleParams = z.object({ retryAfter: retryAfterSchema.optional() }).strict().default({});

const kindSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http_500'), params: noParams }),
  z.object({ kind: z.literal('http_503'), params: throttleParams }),
  z.object({ kind: z.literal('http_429'), params: throttleParams }),
  // `echoRequest`: the OperationOutcome quotes the request's URL and body, as a platform error may echo a NIK (#40).
  z.object({ kind: z.literal('http_400'), params: z.object({ echoRequest: z.boolean().optional() }).strict().default({}) }),
  z.object({ kind: z.literal('http_401'), params: noParams }),
  z.object({ kind: z.literal('timeout'), params: z.object({ ms: holdMs }).strict() }),
  z.object({ kind: z.literal('connection_reset'), params: noParams }),
  z.object({ kind: z.literal('timeout_after_apply'), params: z.object({ ms: holdMs }).strict() }),
  z.object({ kind: z.literal('http_500_after_apply'), params: noParams }),
  z.object({
    kind: z.literal('latency'),
    params: z.union([
      z.object({ ms: holdMs }).strict(),
      z
        .object({ minMs: holdMs, maxMs: holdMs })
        .strict()
        .superRefine((p, ctx) => {
          if (p.minMs > p.maxMs) ctx.addIssue({ code: 'custom', message: `minMs must not exceed maxMs, got ${p.minMs} > ${p.maxMs}` });
        }),
    ]),
  }),
  z.object({ kind: z.literal('hold'), params: noParams }),
]);

const ruleSchema = z
  .object({
    id: z.string().min(1),
    match: z
      .object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        resourceType: z.string().min(1).optional(),
        path: z.string().startsWith('/').optional(),
      })
      .strict(),
    rate: z.number().min(0).max(1).optional(),
    everyNth: z.number().int().min(1).optional(),
    firstN: z.number().int().min(1).optional(),
  })
  .and(kindSchema)
  .superRefine((r, ctx) => {
    const modes = (['rate', 'everyNth', 'firstN'] as const).filter((m) => r[m] !== undefined);
    if (modes.length !== 1) {
      ctx.addIssue({ code: 'custom', message: `rule "${r.id}" needs exactly one of rate, everyNth or firstN, got ${modes.join(', ') || 'none'}` });
    }
  });

/** The body of `PUT /__mock/faults`: a seed and the rules, tried in order; the first that hits a request wins. */
export const faultRulesSchema = z
  .object({ seed: z.number().int(), rules: z.array(ruleSchema) })
  .strict()
  .superRefine((f, ctx) => {
    const repeated = f.rules.map((r) => r.id).filter((id, i, ids) => ids.indexOf(id) !== i);
    if (repeated.length > 0) ctx.addIssue({ code: 'custom', message: `rule ids must be unique, got "${[...new Set(repeated)].join('", "')}" more than once` });
  });

/** Fault rules as sent to `PUT /__mock/faults`. */
export type FaultRulesInput = z.input<typeof faultRulesSchema>;
type FaultRulesConfig = z.output<typeof faultRulesSchema>;
type Rule = FaultRulesConfig['rules'][number];

/** How a `Retry-After` header is sent: delta seconds, or the HTTP date that many seconds from now. */
export type RetryAfter = z.output<typeof retryAfterSchema>;

/** The fault a rule decided for one request, with any random parameter (a latency range) already drawn. */
export type Fault = { ruleId: string } & (
  | { kind: 'http_500' | 'http_401' | 'connection_reset' | 'http_500_after_apply' | 'hold' }
  | { kind: 'http_400'; echoRequest: boolean }
  | { kind: 'http_503' | 'http_429'; retryAfter: RetryAfter | null }
  | { kind: 'timeout' | 'timeout_after_apply' | 'latency'; ms: number }
);

/** What a fault decision looks at. */
export interface FaultedRequest {
  /** HTTP method, as `match.method` names it. */
  method: string;
  /** Path without the query string, which `match.path` is compared with. */
  path: string;
  /** Path and query string, the identifier of a request that has no business identifier. */
  url: string;
  /** The resource type the log files the request under, which `match.resourceType` is compared with. */
  resourceType: string | null;
  /** The record's `system|value` identifier, by which its requests are counted. */
  businessIdentifier: string | null;
}

/** The current fault rules and the per-identifier request counts their decisions depend on. */
export class FaultRules {
  private config: FaultRulesConfig | null = null;
  private counts = new Map<string, number>();

  /** Seed of the current rules, or null when none are set. */
  get seed(): number | null {
    return this.config?.seed ?? null;
  }

  /** Replaces the rules and starts counting requests afresh. */
  set(config: FaultRulesConfig): void {
    this.config = config;
    this.counts.clear();
  }

  /** Removes every rule. */
  clear(): void {
    this.config = null;
    this.counts.clear();
  }

  /**
   * Counts the request and returns the fault of the first rule that matches
   * and hits it, or null. A request is identified by its method, resource
   * type and business identifier, or its path and query when it has none
   * (token, KFA, Location). Requests of one record come from one case, one at
   * a time, so their fates don't depend on other cases; requests without a
   * business identifier are shared across cases, so the same seed gives the
   * same fates to the nth request of each URL, but which case sends the nth
   * depends on arrival order.
   */
  decide(request: FaultedRequest): Fault | null {
    if (this.config === null) return null;
    const identifier =
      request.businessIdentifier === null
        ? `${request.method} ${request.url}`
        : `${request.method} ${request.resourceType ?? ''} ${request.businessIdentifier}`;
    const nth = (this.counts.get(identifier) ?? 0) + 1;
    this.counts.set(identifier, nth);

    const { seed } = this.config;
    for (const rule of this.config.rules) {
      if (!matches(rule, request)) continue;
      const draw = (salt: string) => uniform(seed, rule.id, identifier, nth, salt);
      if (!hits(rule, nth, draw('hit'))) continue;
      return faultOf(rule, draw('param'));
    }
    return null;
  }
}

function matches(rule: Rule, request: FaultedRequest): boolean {
  const { method, resourceType, path } = rule.match;
  return (
    (method === undefined || method === request.method) &&
    (resourceType === undefined || resourceType === request.resourceType) &&
    (path === undefined || path === request.path)
  );
}

function hits(rule: Rule, nth: number, u: number): boolean {
  if (rule.firstN !== undefined) return nth <= rule.firstN;
  if (rule.everyNth !== undefined) return nth % rule.everyNth === 0;
  return u < (rule.rate ?? 0);
}

function faultOf(rule: Rule, u: number): Fault {
  const ruleId = rule.id;
  switch (rule.kind) {
    case 'http_503':
    case 'http_429':
      return { ruleId, kind: rule.kind, retryAfter: rule.params.retryAfter ?? null };
    case 'http_400':
      return { ruleId, kind: 'http_400', echoRequest: rule.params.echoRequest ?? false };
    case 'timeout':
    case 'timeout_after_apply':
      return { ruleId, kind: rule.kind, ms: rule.params.ms };
    case 'latency': {
      const { params } = rule;
      const ms = 'ms' in params ? params.ms : params.minMs + Math.floor(u * (params.maxMs - params.minMs + 1));
      return { ruleId, kind: 'latency', ms };
    }
    default:
      return { ruleId, kind: rule.kind };
  }
}

/** A number in [0, 1) that depends only on its inputs. */
function uniform(seed: number, ruleId: string, identifier: string, nth: number, salt: string): number {
  const digest = createHash('sha256').update(JSON.stringify([seed, ruleId, identifier, nth, salt])).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}
