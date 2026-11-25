import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { validateFaultConfig, type FaultConfig } from './faults.js';
import type { LogEntry } from './log.js';
import { applyFaults, respond } from './respond.js';
import { MockState, type MockSettings } from './state.js';
import { simpleOutcome, tokenRejected, tokenResponse, tokenThrottled } from './templates/index.js';
import { defaultWorldPath, loadWorld, type WorldSeed } from './world/world.js';
import type { Resource } from 'fhir/r4.js';
import { randomUUID } from 'node:crypto';
import { registerFhirRoutes, utcNow } from './fhir.js';
import { encounterIdentifier } from './identity.js';
import { mergePatch } from './merge-patch.js';
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

export { respond, type Outcome } from './respond.js';

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
  app.decorateRequest('epoch', 0);
  app.decorateRequest('identity', null);
  app.decorateRequest('faultId', null);
  app.decorateRequest('afterApply', null);
  app.addHook('onRequest', async (req) => {
    req.receivedAt = new Date().toISOString();
    req.epoch = state.epoch;
  });
  app.addHook('preHandler', (req, reply) => applyFaults(state, req, reply));
  // Parked and delayed requests would otherwise keep `close()` waiting.
  app.addHook('preClose', async () => state.abortPending());

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
  app.put('/__mock/faults', async (req, reply) => {
    const errors = validateFaultConfig(req.body);
    if (errors.length > 0) return reply.code(400).send({ errors });
    state.faults.configure(req.body as FaultConfig);
    return respond(state, req, reply, { status: 204, body: undefined, kind: 'admin' });
  });
  app.get('/__mock/holds', async (req) => {
    const wait = Number((req.query as { wait?: string }).wait ?? 0);
    return state.holds.wait(Number.isFinite(wait) ? wait : 0);
  });
  app.post('/__mock/holds/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!state.holds.release(id)) return reply.code(404).send({ errors: [`no parked request ${id}`] });
    return respond(state, req, reply, { status: 204, body: undefined, kind: 'admin' });
  });
  // --- records, changed behind the hub's back (#33) -----------------------
  const adminRecord = (r: Resource) => {
    const i = encounterIdentifier(r, state);
    return { kind: 'admin' as const, resourceType: r.resourceType, visitKey: i?.value ?? null, businessIdentifier: i ? `${i.system}|${i.value}` : null };
  };
  const unknownRecord = (type: string, id: string) => ({ errors: [`no ${type}/${id}`] });
  app.post('/__mock/records', async (req, reply) => {
    const body = req.body as Resource | null;
    if (body === null || typeof body !== 'object' || typeof body.resourceType !== 'string') {
      return reply.code(400).send({ errors: ['body must be a FHIR resource'] });
    }
    const id = body.id ?? randomUUID();
    const stored = { ...body, id, meta: { versionId: state.nextVersionId(), lastUpdated: utcNow(), ...body.meta } } as Resource;
    state.recordsOf(stored.resourceType).set(id, stored);
    return respond(state, req, reply, { status: 201, body: stored, ...adminRecord(stored) });
  });
  app.patch('/__mock/records/:type/:id', async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const records = state.recordsOf(type);
    const existing = records.get(id);
    if (!existing) return reply.code(404).send(unknownRecord(type, id));
    const merged = mergePatch(existing, req.body ?? {}) as Resource;
    const stored = { ...merged, resourceType: type, id, meta: { ...merged.meta, versionId: state.nextVersionId(), lastUpdated: utcNow() } } as Resource;
    records.set(id, stored);
    return respond(state, req, reply, { status: 200, body: stored, ...adminRecord(stored) });
  });
  app.delete('/__mock/records/:type/:id', async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const records = state.recordsOf(type);
    const existing = records.get(id);
    if (!existing) return reply.code(404).send(unknownRecord(type, id));
    records.delete(id);
    return respond(state, req, reply, { status: 204, body: undefined, ...adminRecord(existing) });
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
