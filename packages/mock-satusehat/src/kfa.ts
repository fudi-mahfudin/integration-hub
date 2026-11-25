import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { respond, type Outcome } from './respond.js';
import type { MockState } from './state.js';
import { kfaBadQuery, kfaNotFound, kfaProductDetail, simpleOutcome } from './templates/index.js';

/** KFA v2 product detail from the mock's own synthetic catalogue (#10, ADR 0006); same token as FHIR (#14). */
export function registerKfaRoutes(kfa: FastifyInstance, state: MockState): void {
  const send = (req: FastifyRequest, reply: FastifyReply, o: Outcome) => respond(state, req, reply, o);

  kfa.addHook('preHandler', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!state.isTokenValid(token, Date.now())) {
      return send(req, reply, { status: 401, body: simpleOutcome.build('security', 'invalid or expired access token') });
    }
  });

  kfa.get('/products', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const keys = Object.keys(query).sort();
    if (keys.join(',') !== 'code,identifier' || query.identifier !== 'kfa' || !query.code) {
      return send(req, reply, { status: 400, body: kfaBadQuery.build(new URLSearchParams(query as Record<string, string>).toString()) });
    }
    const product = state.kfaByCode.get(query.code);
    if (!product) return send(req, reply, { status: 404, body: kfaNotFound.build(query.code) });
    return send(req, reply, { status: 200, body: kfaProductDetail.build(product, state.kfaByCode) });
  });
}
