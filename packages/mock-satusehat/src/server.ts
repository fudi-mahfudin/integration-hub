import type { z } from 'zod';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Clock } from './clock.js';
import { faultRulesSchema, type Fault, type FaultRules, type RetryAfter } from './faults.js';
import type { Parking } from './parking.js';
import { isRecordType, noEffect, RECORD_TYPES, type About, type PendingRequest, type Platform, type PlatformResponse, type RecordType } from './platform.js';
import { computeReport } from './report.js';
import type { Effect, LogQuery, SubmissionLog } from './submission-log.js';
import * as templates from './templates/index.js';
import { worldEntriesSchema } from './world/world.js';

const FHIR_BASE = '/fhir-r4/v1';
const TOKEN_PATH = '/oauth2/v1/accesstoken';
const KFA_PRODUCTS_PATH = '/kfa-v2/products';
const FHIR_JSON = 'application/fhir+json';
const MAX_LOG_LIMIT = 10_000;
const MAX_HOLD_WAIT_MS = 60_000;

/** What the HTTP server serves from. */
export interface ServerDeps {
  platform: Platform;
  log: SubmissionLog;
  faults: FaultRules;
  parking: Parking;
  clock: Clock;
}

type Applied = About & { effect: Effect };

/**
 * What a platform request gets: an answer (the platform's or an injected
 * one), or a connection cut without one, reset at once or dropped.
 */
type Outcome =
  | ({ kind: 'answer'; status: number; body: unknown; headers: Record<string, string> } & Applied)
  | ({ kind: 'cut'; how: 'reset' | 'drop' } & Applied)
  | { kind: 'dropped' };

/**
 * Builds the HTTP server: the SATUSEHAT-facing paths, each request logged,
 * and the `/__mock/*` inspection and control API, which is never logged.
 * Bodies are taken as raw strings and parsed here, at the boundary, so a
 * malformed body is still answered and logged like the platform would.
 */
export function buildServer({ platform, log, faults, parking, clock }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  /**
   * Answers a platform request, or lets the fault rule that hits it answer
   * instead, and appends it to the submission log with that rule's id.
   */
  function platformRoute(contentType: string, read: (req: FastifyRequest) => { requestBody: unknown; pending: PendingRequest }) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const receivedAt = clock().toISOString();
      const { requestBody, pending } = read(req);
      const { resourceType, businessIdentifier } = pending.about;
      const fault = faults.decide({ method: req.method, path: pathOf(req.url), url: req.url, resourceType, businessIdentifier });
      const outcome = await outcomeOf(fault, pending, req);
      if (outcome.kind === 'dropped') {
        // Reset or close came while it waited: the log it belonged to is gone, so it is neither answered nor logged.
        reply.hijack();
        req.raw.socket.destroy();
        return reply;
      }

      const { status, body, headers, ...about } = outcome.kind === 'answer' ? outcome : { ...outcome, status: null, body: null, headers: {} };
      log.append({
        receivedAt,
        respondedAt: clock().toISOString(),
        method: req.method,
        path: req.url,
        resourceType: about.resourceType,
        visitKey: about.visitKey,
        businessIdentifier: about.businessIdentifier,
        request: { body: requestBody },
        response: { status, body },
        fault: fault?.ruleId ?? null,
        effect: about.effect,
      });
      if (status !== null) return reply.status(status).type(contentType).headers(headers).send(body);
      reply.hijack();
      if (outcome.kind === 'cut' && outcome.how === 'reset') req.raw.socket.resetAndDestroy();
      else req.raw.socket.destroy();
      return reply;
    };
  }

  /** What a request gets: the platform's answer, or what `fault` makes of it. */
  async function outcomeOf(fault: Fault | null, pending: PendingRequest, req: FastifyRequest): Promise<Outcome> {
    const notApplied = { ...aboutOnly(pending.about), effect: 'none' as const };
    const injected = (status: number, body: unknown, headers: Record<string, string> = {}): Outcome => ({
      kind: 'answer', status, body, headers, ...notApplied,
    });
    if (fault === null) return { kind: 'answer', headers: {}, ...pending.apply() };
    switch (fault.kind) {
      case 'http_500':
        return injected(500, templates.injectedFailure(500, fault.ruleId));
      case 'http_503':
      case 'http_429': {
        const status = fault.kind === 'http_503' ? 503 : 429;
        return injected(status, templates.injectedFailure(status, fault.ruleId), retryAfterHeader(fault.retryAfter));
      }
      case 'http_400':
        return injected(
          400,
          fault.echoRequest
            ? templates.echoingRejection(fault.ruleId, req.url, typeof req.body === 'string' ? req.body : '')
            : templates.payloadRejected([
                { code: 'PAYLOAD_INVALID', path: notApplied.resourceType ?? '(request)', message: `rejected by mock fault rule "${fault.ruleId}"` },
              ]),
        );
      case 'http_401':
        return injected(401, templates.unauthorized());
      case 'connection_reset':
        return { kind: 'cut', how: 'reset', ...notApplied };
      case 'timeout': {
        if (!(await waitUnlessClientGone(fault.ms, req))) return { kind: 'dropped' };
        return { kind: 'cut', how: 'drop', ...notApplied };
      }
      case 'timeout_after_apply': {
        const applied = pending.apply();
        if (!(await waitUnlessClientGone(fault.ms, req))) return { kind: 'dropped' };
        return { kind: 'cut', how: 'drop', ...aboutOnly(applied), effect: applied.effect };
      }
      case 'latency': {
        if (!(await parking.wait(fault.ms))) return { kind: 'dropped' };
        return { kind: 'answer', headers: {}, ...pending.apply() };
      }
      case 'hold': {
        if (!(await parking.hold({ ruleId: fault.ruleId, method: req.method, path: req.url, ...aboutOnly(pending.about) }))) {
          return { kind: 'dropped' };
        }
        return { kind: 'answer', headers: {}, ...pending.apply() };
      }
      case 'http_500_after_apply': {
        const applied = pending.apply();
        return { kind: 'answer', ...applied, status: 500, body: templates.injectedFailure(500, fault.ruleId), headers: {} };
      }
    }
  }

  /**
   * A timeout's hold: `ms`, or less if the client gives up first. Nothing
   * more can happen to a request whose client has gone, so it ends then: it
   * is logged as cut at that moment, and a retry the client sends next never
   * overlaps it. Resolves `false` if everything waiting is dropped first.
   */
  async function waitUnlessClientGone(ms: number, req: FastifyRequest): Promise<boolean> {
    const { socket } = req.raw;
    if (socket.destroyed) return true;
    let onClose = () => {};
    const gone = new Promise<true>((resolve) => {
      onClose = () => resolve(true);
      socket.once('close', onClose);
    });
    try {
      return await Promise.race([parking.wait(ms), gone]);
    } finally {
      socket.off('close', onClose);
    }
  }

  function retryAfterHeader(retryAfter: RetryAfter | null): Record<string, string> {
    if (retryAfter === null) return {};
    if (retryAfter.form === 'seconds') return { 'retry-after': String(retryAfter.seconds) };
    return { 'retry-after': new Date(clock().getTime() + retryAfter.seconds * 1000).toUTCString() };
  }

  app.post(
    TOKEN_PATH,
    platformRoute('application/json', (req) => {
      const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
      const clientId = form.get('client_id');
      const answer = platform.requestToken(queryOf(req).get('grant_type'), clientId, form.get('client_secret'));
      // client_secret is left out of the log on purpose.
      return { pending: answer, requestBody: { client_id: clientId } };
    }),
  );

  /**
   * `pending`, applied only with a valid access token: without one it is
   * answered 401 and logged as about no visit. The token is checked when the
   * request is applied, so one that expires while a request is held counts.
   */
  const authorized = (req: FastifyRequest, resourceType: string, pending: PendingRequest): PendingRequest => ({
    about: pending.about,
    apply: () =>
      platform.isAuthorized(req.headers.authorization)
        ? pending.apply()
        : { status: 401, body: templates.unauthorized(), ...noEffect(resourceType) },
  });

  app.get(
    `${FHIR_BASE}/:resourceType`,
    platformRoute(FHIR_JSON, (req) => {
      const { resourceType } = req.params as { resourceType: string }; // the route has exactly this parameter
      return { pending: authorized(req, resourceType, platform.search(resourceType, queryOf(req))), requestBody: null };
    }),
  );

  app.get(
    KFA_PRODUCTS_PATH,
    platformRoute('application/json', (req) => {
      // KFA v2 takes the same access token as FHIR (#14).
      return { pending: authorized(req, 'KfaProduct', platform.kfaProduct(queryOf(req))), requestBody: null };
    }),
  );

  app.post(
    `${FHIR_BASE}/Encounter`,
    platformRoute(FHIR_JSON, (req) => {
      const requestBody = parseJson(req.body);
      return { pending: authorized(req, 'Encounter', platform.createEncounter(requestBody)), requestBody };
    }),
  );

  app.put(
    `${FHIR_BASE}/Encounter/:id`,
    platformRoute(FHIR_JSON, (req) => {
      const { id } = req.params as { id: string }; // the route has exactly this parameter
      const requestBody = parseJson(req.body);
      return { pending: authorized(req, 'Encounter', platform.updateEncounter(id, requestBody)), requestBody };
    }),
  );

  app.post(
    `${FHIR_BASE}/MedicationRequest`,
    platformRoute(FHIR_JSON, (req) => {
      const requestBody = parseJson(req.body);
      return { pending: authorized(req, 'MedicationRequest', platform.createMedicationRequest(requestBody)), requestBody };
    }),
  );

  app.post(
    `${FHIR_BASE}/MedicationDispense`,
    platformRoute(FHIR_JSON, (req) => {
      const requestBody = parseJson(req.body);
      return { pending: authorized(req, 'MedicationDispense', platform.createMedicationDispense(requestBody)), requestBody };
    }),
  );

  app.get('/__mock/log', async (req, reply) => {
    const query = parseLogQuery(queryOf(req));
    if (typeof query === 'string') return reply.status(400).send({ error: query });
    return { entries: log.query(query) };
  });

  app.get('/__mock/log.ndjson', async (_req, reply) => {
    const lines = log.all().map((e) => `${JSON.stringify(e)}\n`).join('');
    return reply.type('application/x-ndjson').send(lines);
  });

  app.get('/__mock/report', async () => computeReport(log.all(), faults.seed));

  app.put('/__mock/faults', async (req, reply) => {
    const parsed = faultRulesSchema.safeParse(parseJson(req.body));
    if (!parsed.success) return reply.status(400).send({ error: `fault rules are invalid; ${problemsOf(parsed.error)}` });
    faults.set(parsed.data);
    return reply.status(204).send();
  });

  app.post('/__mock/reset', async (_req, reply) => {
    platform.reset();
    faults.clear();
    parking.dropAll();
    log.clear();
    return reply.status(204).send();
  });

  app.post('/__mock/seed', async (req, reply) => {
    const parsed = worldEntriesSchema.safeParse(parseJson(req.body));
    if (!parsed.success) {
      return reply.status(400).send({ error: `seed entries are invalid; ${problemsOf(parsed.error)}` });
    }
    platform.seed(parsed.data);
    return reply.status(204).send();
  });

  app.get('/__mock/holds', async (req, reply) => {
    const raw = queryOf(req).get('wait') ?? '0';
    const waitMs = Number(raw);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_HOLD_WAIT_MS) {
      return reply.status(400).send({ error: `wait must be an integer 0-${MAX_HOLD_WAIT_MS} (ms), got "${raw}"` });
    }
    return { holds: await parking.holds(waitMs) };
  });

  app.post('/__mock/holds/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string }; // the route has exactly this parameter
    if (!parking.release(id)) return reply.status(404).send({ error: `no request is parked under hold "${id}"` });
    return reply.status(204).send();
  });

  /** A `/__mock/records` mutation; an applied one is logged as an admin entry, a refused one is not logged. */
  function recordRoute(change: (req: FastifyRequest, requestBody: unknown) => PlatformResponse) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const receivedAt = clock().toISOString();
      const requestBody = parseJson(req.body);
      const { status, body, effect, ...about } = change(req, requestBody);
      if (effect === 'admin') {
        log.append({
          receivedAt,
          respondedAt: clock().toISOString(),
          method: req.method,
          path: req.url,
          ...aboutOnly(about),
          request: { body: requestBody },
          response: { status, body },
          fault: null,
          effect,
        });
      }
      return reply.status(status).send(body ?? undefined);
    };
  }

  /** The record type and id of a `/__mock/records/{type}/{id}` route, or the 400 answer for a type the mock doesn't store. */
  const recordParams = (req: FastifyRequest): { type: RecordType; id: string } | PlatformResponse => {
    const { type, id } = req.params as { type: string; id: string }; // the route has exactly these parameters
    if (isRecordType(type)) return { type, id };
    return { status: 400, body: { error: `record type must be one of ${RECORD_TYPES.join(', ')}, got "${type}"` }, ...noEffect(type) };
  };

  app.delete(
    '/__mock/records/:type/:id',
    recordRoute((req) => {
      const target = recordParams(req);
      return 'status' in target ? target : platform.deleteRecord(target.type, target.id);
    }),
  );

  app.patch(
    '/__mock/records/:type/:id',
    recordRoute((req, patch) => {
      const target = recordParams(req);
      return 'status' in target ? target : platform.patchRecord(target.type, target.id, patch);
    }),
  );

  app.post('/__mock/records', recordRoute((_req, record) => platform.insertRecord(record)));

  app.post('/__mock/tokens/revoke', async (_req, reply) => {
    platform.revokeTokens();
    return reply.status(204).send();
  });

  // Every other request is a platform request too, and is logged as a 404.
  app.setNotFoundHandler(
    platformRoute(FHIR_JSON, (req) => {
      const resourceType = req.url.startsWith(`${FHIR_BASE}/`) ? (req.url.slice(FHIR_BASE.length + 1).split(/[/?]/)[0] ?? null) : null;
      const answer = { status: 404, body: templates.notFound(pathOf(req.url)), ...noEffect(resourceType || null) };
      return { pending: { about: noEffect(resourceType || null), apply: () => answer }, requestBody: parseJson(req.body) };
    }),
  );

  // A request kept waiting would otherwise keep close() waiting with it.
  app.addHook('preClose', async () => parking.dropAll());

  return app;
}

/** The first few issues of a rejected `/__mock/*` body, each naming where it is. */
function problemsOf(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Only what a request is about, without any other field the object carries. */
function aboutOnly({ resourceType, visitKey, businessIdentifier }: About): About {
  return { resourceType, visitKey, businessIdentifier };
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

function queryOf(req: FastifyRequest): URLSearchParams {
  return new URL(req.url, 'http://mock.invalid').searchParams;
}

/** A JSON body as `unknown`; a non-JSON body is kept as its raw string so the validator rejects it. */
function parseJson(body: unknown): unknown {
  if (typeof body !== 'string' || body === '') return body ?? null;
  try {
    return JSON.parse(body);
  } catch {
    // Not JSON: hand the raw text on, which every schema rejects.
    return body;
  }
}

function parseLogQuery(params: URLSearchParams): LogQuery | string {
  const query: LogQuery = {};
  const visitKey = params.get('visitKey');
  const resourceType = params.get('resourceType');
  if (visitKey) query.visitKey = visitKey;
  if (resourceType) query.resourceType = resourceType;
  for (const name of ['afterSeq', 'limit'] as const) {
    const raw = params.get(name);
    if (raw === null || raw === '') continue;
    const n = Number(raw);
    const min = name === 'limit' ? 1 : 0;
    const max = name === 'limit' ? MAX_LOG_LIMIT : Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(n) || n < min || n > max) return `${name} must be an integer ${min}-${max}, got "${raw}"`;
    query[name] = n;
  }
  return query;
}
