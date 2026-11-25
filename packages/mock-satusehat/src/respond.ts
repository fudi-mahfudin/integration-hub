import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Socket } from 'node:net';
import { retryAfterHeader, type FaultRule } from './faults.js';
import { requestIdentity, type RequestIdentity } from './identity.js';
import type { LogEntry } from './log.js';
import type { MockState } from './state.js';
import { faultOutcome, validationOutcome } from './templates/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    receivedAt: string;
    /** `MockState.epoch` when the request arrived; entries from before a reset are not logged. */
    epoch: number;
    identity: RequestIdentity | null;
    /** Rule id to log on this request (a fault that fired, or the last delay rule). */
    faultId: string | null;
    /** An apply-then-fail rule that fired: the handler runs, then `respond` fails the reply. */
    afterApply: FaultRule | null;
  }
}

/** What a handler decided; `respond` sends it and logs it. */
export interface Outcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  resourceType?: string | null;
  visitKey?: string | null;
  businessIdentifier?: string | null;
  effect?: LogEntry['effect'];
  kind?: LogEntry['kind'];
}

/** Default cap on how long a `timeout` fault holds a request whose client never hangs up. */
const DEFAULT_TIMEOUT_HOLD_MS = 30_000;

function logEntry(state: MockState, req: FastifyRequest, o: Outcome): void {
  if (req.epoch !== state.epoch) return;
  const url = new URL(req.url, 'http://mock');
  state.append({
    kind: o.kind ?? 'platform',
    receivedAt: req.receivedAt,
    respondedAt: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    resourceType: o.resourceType ?? req.identity?.resourceType ?? null,
    visitKey: o.visitKey ?? req.identity?.visitKey ?? null,
    businessIdentifier: o.businessIdentifier ?? req.identity?.businessIdentifier ?? null,
    request: { query: Object.fromEntries(url.searchParams), body: req.body ?? null },
    response: { status: o.status, body: o.body ?? null },
    fault: o.kind === 'admin' ? null : req.faultId,
    effect: o.effect ?? 'none',
  });
}

export function respond(state: MockState, req: FastifyRequest, reply: FastifyReply, o: Outcome): FastifyReply {
  const after = o.kind === 'admin' ? null : req.afterApply;
  if (after !== null) {
    req.afterApply = null;
    if (after.kind === 'timeout_after_apply') return drop(state, req, reply, o.effect ?? 'none', after.params?.ms);
    return respond(state, req, reply, { ...o, status: 500, headers: {}, body: faultOutcome.build(500, after.id) });
  }
  logEntry(state, req, o);
  reply.code(o.status);
  if (o.headers) reply.headers(o.headers);
  return o.body === undefined ? reply.send() : reply.send(o.body);
}

/**
 * Never answers: holds the request until the client hangs up (or `holdMs`,
 * or a reset), then logs it with status 0 and destroys the socket. `holdMs`
 * 0 resets the connection at once.
 */
function drop(state: MockState, req: FastifyRequest, reply: FastifyReply, effect: LogEntry['effect'], holdMs = DEFAULT_TIMEOUT_HOLD_MS): FastifyReply {
  reply.hijack();
  const socket = req.raw.socket as Socket;
  const finish = () => {
    logEntry(state, req, { status: 0, body: null, effect });
    if (!socket.destroyed) holdMs === 0 ? socket.resetAndDestroy() : socket.destroy();
  };
  if (holdMs === 0) {
    finish();
  } else {
    void untilHangUpOr(reply, holdMs, state.pendingSignal).then(finish);
  }
  return reply;
}

function untilHangUpOr(reply: FastifyReply, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      reply.raw.off('close', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    reply.raw.once('close', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * App-level `preHandler`: decides the request's faults (#33) before any route
 * logic, including the token endpoint and FHIR auth. `/__mock/*` is exempt.
 */
export async function applyFaults(state: MockState, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const path = new URL(req.url, 'http://mock').pathname;
  if (path.startsWith('/__mock/')) return undefined;
  const identity = requestIdentity(req, state);
  req.identity = identity;
  const decision = state.faults.decide({ method: req.method, path, resourceType: identity.resourceType, key: identity.faultKey });

  for (const { rule, ms } of decision.delays) {
    req.faultId = rule.id;
    if (rule.kind === 'latency') {
      await sleep(ms ?? 0, state.pendingSignal);
      if (req.epoch !== state.epoch) return drop(state, req, reply, 'none', 0); // cut short by a reset
      continue;
    }
    const fate = await state.holds.park({
      ruleId: rule.id,
      method: req.method,
      path,
      visitKey: identity.visitKey,
      businessIdentifier: identity.businessIdentifier,
    });
    if (fate === 'drop') return drop(state, req, reply, 'none', 0);
  }

  const rule = decision.terminal;
  if (rule === null) return undefined;
  req.faultId = rule.id;
  const fail = (status: number, headers: Record<string, string> = {}) =>
    respond(state, req, reply, { status, headers, body: faultOutcome.build(status, rule.id) });
  switch (rule.kind) {
    case 'http_500':
      return fail(500);
    case 'http_401':
      return fail(401);
    case 'http_503':
      return fail(503, retryAfterHeader(rule.params, Date.now()));
    case 'http_429':
      return fail(429, retryAfterHeader(rule.params, Date.now()));
    case 'http_400':
      return respond(state, req, reply, {
        status: 400,
        body: validationOutcome.build([
          {
            code: rule.params?.code ?? 'PAYLOAD_INVALID',
            rule: rule.params?.rule ?? 'FAULT_INJECTED',
            path: identity.resourceType ?? path,
            message: `injected fault ${rule.id}`,
          },
        ]),
      });
    case 'timeout':
      return drop(state, req, reply, 'none', rule.params?.ms);
    case 'connection_reset':
      return drop(state, req, reply, 'none', 0);
    case 'timeout_after_apply':
    case 'http_500_after_apply':
      req.afterApply = rule;
      return undefined;
    default:
      return undefined;
  }
}
