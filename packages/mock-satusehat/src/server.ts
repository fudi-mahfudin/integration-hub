import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Clock } from './clock.js';
import { noEffect, type Platform, type PlatformResponse } from './platform.js';
import { computeReport } from './report.js';
import type { LogQuery, SubmissionLog } from './submission-log.js';
import * as templates from './templates/index.js';
import { worldEntriesSchema } from './world/world.js';

const FHIR_BASE = '/fhir-r4/v1';
const TOKEN_PATH = '/oauth2/v1/accesstoken';
const KFA_PRODUCTS_PATH = '/kfa-v2/products';
const FHIR_JSON = 'application/fhir+json';
const MAX_LOG_LIMIT = 10_000;

/** What the HTTP server serves from. */
export interface ServerDeps {
  platform: Platform;
  log: SubmissionLog;
  clock: Clock;
}

/**
 * Builds the HTTP server: the SATUSEHAT-facing paths, each request logged,
 * and the `/__mock/*` inspection and control API, which is never logged.
 * Bodies are taken as raw strings and parsed here, at the boundary, so a
 * malformed body is still answered and logged like the platform would.
 */
export function buildServer({ platform, log, clock }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  /** Answers a platform request and appends it to the submission log. */
  function platformRoute(contentType: string, handle: (req: FastifyRequest) => PlatformResponse & { requestBody: unknown }) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const receivedAt = clock().toISOString();
      const { requestBody, status, body, ...about } = handle(req);
      log.append({
        receivedAt,
        respondedAt: clock().toISOString(),
        method: req.method,
        path: req.url,
        request: { body: requestBody },
        response: { status, body },
        fault: null,
        ...about,
      });
      return reply.status(status).type(contentType).send(body);
    };
  }

  app.post(
    TOKEN_PATH,
    platformRoute('application/json', (req) => {
      const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
      const clientId = form.get('client_id');
      const answer = platform.requestToken(queryOf(req).get('grant_type'), clientId, form.get('client_secret'));
      // client_secret is left out of the log on purpose.
      return { ...answer, requestBody: { client_id: clientId } };
    }),
  );

  const unauthorizedFor = (resourceType: string, requestBody: unknown) => ({
    status: 401, body: templates.unauthorized(), ...noEffect(resourceType), requestBody,
  });

  app.get(
    `${FHIR_BASE}/:resourceType`,
    platformRoute(FHIR_JSON, (req) => {
      const { resourceType } = req.params as { resourceType: string }; // the route has exactly this parameter
      if (!platform.isAuthorized(req.headers.authorization)) return unauthorizedFor(resourceType, null);
      return { ...platform.search(resourceType, queryOf(req)), requestBody: null };
    }),
  );

  app.get(
    KFA_PRODUCTS_PATH,
    platformRoute('application/json', (req) => {
      // KFA v2 takes the same access token as FHIR (#14).
      if (!platform.isAuthorized(req.headers.authorization)) return unauthorizedFor('KfaProduct', null);
      return { ...platform.kfaProduct(queryOf(req)), requestBody: null };
    }),
  );

  app.post(
    `${FHIR_BASE}/Encounter`,
    platformRoute(FHIR_JSON, (req) => {
      const requestBody = parseJson(req.body);
      if (!platform.isAuthorized(req.headers.authorization)) return unauthorizedFor('Encounter', requestBody);
      return { ...platform.createEncounter(requestBody), requestBody };
    }),
  );

  app.post(
    `${FHIR_BASE}/MedicationRequest`,
    platformRoute(FHIR_JSON, (req) => {
      const requestBody = parseJson(req.body);
      if (!platform.isAuthorized(req.headers.authorization)) return unauthorizedFor('MedicationRequest', requestBody);
      return { ...platform.createMedicationRequest(requestBody), requestBody };
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

  app.get('/__mock/report', async () => computeReport(log.all(), null));

  app.post('/__mock/reset', async (_req, reply) => {
    platform.reset();
    log.clear();
    return reply.status(204).send();
  });

  app.post('/__mock/seed', async (req, reply) => {
    const parsed = worldEntriesSchema.safeParse(parseJson(req.body));
    if (!parsed.success) {
      const problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      return reply.status(400).send({ error: `seed entries are invalid; ${problems.join('; ')}` });
    }
    platform.seed(parsed.data);
    return reply.status(204).send();
  });

  app.post('/__mock/tokens/revoke', async (_req, reply) => {
    platform.revokeTokens();
    return reply.status(204).send();
  });

  // Every other request is a platform request too, and is logged as a 404.
  app.setNotFoundHandler(
    platformRoute(FHIR_JSON, (req) => {
      const resourceType = req.url.startsWith(`${FHIR_BASE}/`) ? (req.url.slice(FHIR_BASE.length + 1).split(/[/?]/)[0] ?? null) : null;
      return {
        status: 404, body: templates.notFound(req.url.split('?')[0] ?? req.url), ...noEffect(resourceType || null),
        requestBody: parseJson(req.body),
      };
    }),
  );

  return app;
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
