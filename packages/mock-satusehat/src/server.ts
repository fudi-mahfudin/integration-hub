import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { LogEntry } from './log.js';
import { MockState, type MockSettings } from './state.js';
import { simpleOutcome, tokenRejected, tokenResponse, tokenThrottled } from './templates/index.js';
import { defaultWorldPath, loadWorld, type WorldSeed } from './world/world.js';
import { registerFhirRoutes } from './fhir.js';
import { reportFromLog } from './report.js';

export interface MockOptions {
  host?: string;
  port?: number;
  worldPath?: string;
  /** Default 3599, as the sandbox sends. */
  tokenExpiresInSeconds?: number;
  /** Default 60s, the documented throttle after a failed token request. */
  tokenThrottleWindowMs?: number;
}

export interface RunningMock {
  /** e.g. `http://127.0.0.1:41234`. FHIR base is `${baseUrl}/fhir-r4/v1`. */
  baseUrl: string;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    receivedAt: string;
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

export function respond(state: MockState, req: FastifyRequest, reply: FastifyReply, o: Outcome): FastifyReply {
  const url = new URL(req.url, 'http://mock');
  state.append({
    kind: o.kind ?? 'platform',
    receivedAt: req.receivedAt,
    respondedAt: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    resourceType: o.resourceType ?? null,
    visitKey: o.visitKey ?? null,
    businessIdentifier: o.businessIdentifier ?? null,
    request: { query: Object.fromEntries(url.searchParams), body: req.body ?? null },
    response: { status: o.status, body: o.body ?? null },
    fault: null,
    effect: o.effect ?? 'none',
  });
  reply.code(o.status);
  if (o.headers) reply.headers(o.headers);
  return o.body === undefined ? reply.send() : reply.send(o.body);
}

/** Builds the mock app without listening. */
export function createMockApp(options: MockOptions = {}): FastifyInstance {
  const settings: MockSettings = {
    tokenExpiresInSeconds: options.tokenExpiresInSeconds ?? 3599,
    tokenThrottleWindowMs: options.tokenThrottleWindowMs ?? 60_000,
  };
  const state = new MockState(loadWorld(options.worldPath ?? defaultWorldPath), settings);
  const app = Fastify({ logger: false });

  app.register(formbody);
  app.addContentTypeParser('application/fhir+json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  app.decorateRequest('receivedAt', '');
  app.addHook('onRequest', async (req) => {
    req.receivedAt = new Date().toISOString();
  });

  // --- token endpoint ----------------------------------------------------
  app.post('/oauth2/v1/accesstoken', async (req, reply) => {
    const now = Date.now();
    const throttled = state.tokenThrottleRemainingMs(now);
    if (throttled > 0) {
      const seconds = Math.ceil(throttled / 1000);
      return respond(state, req, reply, { status: 429, headers: { 'retry-after': String(seconds) }, body: tokenThrottled.build(seconds) });
    }
    const query = req.query as Record<string, string | undefined>;
    const form = (req.body ?? {}) as Record<string, string | undefined>;
    if (query.grant_type !== 'client_credentials') {
      state.recordFailedTokenRequest(now);
      return respond(state, req, reply, { status: 400, body: tokenRejected.build('unsupported grant_type') });
    }
    const org = state.organization;
    if (form.client_id !== org.clientId || form.client_secret !== org.clientSecret) {
      state.recordFailedTokenRequest(now);
      return respond(state, req, reply, { status: 401, body: tokenRejected.build('invalid client credentials') });
    }
    const accessToken = state.issueToken(now);
    return respond(state, req, reply, {
      status: 200,
      body: tokenResponse.build({
        accessToken,
        clientId: org.clientId,
        organizationName: org.name,
        issuedAtMs: now,
        expiresInSeconds: settings.tokenExpiresInSeconds,
      }),
    });
  });

  // --- FHIR --------------------------------------------------------------
  app.register(async (fhir) => registerFhirRoutes(fhir, state), { prefix: '/fhir-r4/v1' });

  // --- inspection and control ---------------------------------------------
  app.post('/__mock/reset', async (_req, reply) => {
    state.reset();
    return reply.code(204).send();
  });
  app.post('/__mock/seed', async (req, reply) => {
    state.seed((req.body ?? {}) as WorldSeed);
    return respond(state, req, reply, { status: 204, body: undefined, kind: 'admin' });
  });
  app.post('/__mock/tokens/revoke', async (req, reply) => {
    state.revokeTokens();
    return respond(state, req, reply, { status: 204, body: undefined, kind: 'admin' });
  });
  app.get('/__mock/log', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const afterSeq = q.afterSeq === undefined ? 0 : Number(q.afterSeq);
    const limit = q.limit === undefined ? Infinity : Number(q.limit);
    const out: LogEntry[] = [];
    for (const e of state.log) {
      if (out.length >= limit) break;
      if (e.seq <= afterSeq) continue;
      if (q.visitKey !== undefined && e.visitKey !== q.visitKey) continue;
      if (q.resourceType !== undefined && e.resourceType !== q.resourceType) continue;
      out.push(e);
    }
    return out;
  });
  app.get('/__mock/log.ndjson', async (_req, reply) => {
    reply.type('application/x-ndjson');
    return state.log.map((e) => `${JSON.stringify(e)}\n`).join('');
  });
  app.get('/__mock/report', async () => reportFromLog(state.log, state.faultSeed));

  // Framework-level failures (e.g. a body that is not JSON) are logged like any other request.
  app.setErrorHandler((err: { statusCode?: number; message: string }, req, reply) => {
    const status = err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    const resourceType = /^\/fhir-r4\/v1\/([A-Za-z]+)/.exec(new URL(req.url, 'http://mock').pathname)?.[1] ?? null;
    return respond(state, req, reply, { status, resourceType, body: simpleOutcome.build('invalid', err.message) });
  });

  app.setNotFoundHandler((req, reply) =>
    respond(state, req, reply, { status: 404, body: simpleOutcome.build('not-found', `no route ${req.method} ${req.url}`) }),
  );

  return app;
}

/** Boots the mock on a port (0 = random) and resolves once it listens. */
export async function startMock(options: MockOptions = {}): Promise<RunningMock> {
  const app = createMockApp(options);
  const host = options.host ?? '127.0.0.1';
  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error(`unexpected address ${String(address)}`);
  return {
    baseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    close: () => app.close(),
  };
}
