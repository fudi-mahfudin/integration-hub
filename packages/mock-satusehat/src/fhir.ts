import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Resource } from 'fhir/r4.js';
import { respond, type Outcome } from './server.js';
import type { MockState } from './state.js';
import { locationResource, searchBundle, simpleOutcome } from './templates/index.js';

type Query = Record<string, string | undefined>;

export function registerFhirRoutes(fhir: FastifyInstance, state: MockState): void {
  const send = (req: FastifyRequest, reply: FastifyReply, o: Outcome) => respond(state, req, reply, o);

  fhir.addHook('preHandler', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!state.isTokenValid(token, Date.now())) {
      const resourceType = (req.params as { type?: string }).type ?? null;
      return send(req, reply, { status: 401, resourceType, body: simpleOutcome.build('security', 'invalid or expired access token') });
    }
  });

  fhir.get('/:type', async (req, reply) => {
    const { type } = req.params as { type: string };
    const query = req.query as Query;
    const base = baseUrl(req);
    const bundle = (hits: Resource[], extra: Partial<Outcome> = {}) =>
      send(req, reply, { status: 200, resourceType: type, body: searchBundle.build(base, hits), ...extra });
    const badSearch = () =>
      send(req, reply, {
        status: 400,
        resourceType: type,
        body: simpleOutcome.build('not-supported', `unsupported search on ${type}: ${Object.keys(query).join(', ') || '(none)'}`),
      });

    const keys = Object.keys(query);
    if (type === 'Location' && only(keys, '_id')) {
      const l = state.locationsById.get(query._id!);
      return bundle(l ? [locationResource.build(l)] : []);
    }
    return badSearch();
  });
}

function only(keys: string[], ...allowed: string[]): boolean {
  return keys.length === allowed.length && allowed.every((k) => keys.includes(k));
}

function baseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}/fhir-r4/v1`;
}
