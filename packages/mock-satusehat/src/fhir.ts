import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Encounter, Resource } from 'fhir/r4.js';
import { respond, type Outcome } from './server.js';
import type { MockState } from './state.js';
import {
  locationResource,
  NIK_SYSTEM,
  patientResource,
  practitionerResource,
  searchBundle,
  simpleOutcome,
  storedEncounter,
  validationOutcome,
} from './templates/index.js';
import { validateEncounter } from './validation/encounter.js';

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
    if ((type === 'Patient' || type === 'Practitioner') && only(keys, 'identifier')) {
      const nik = valueFor(query.identifier!, NIK_SYSTEM);
      if (nik === null) return badSearch();
      if (type === 'Patient') {
        const p = state.patientsByNik.get(nik);
        return bundle(p ? [patientResource.build(p)] : []);
      }
      const p = state.practitionersByNik.get(nik);
      return bundle(p ? [practitionerResource.build(p)] : []);
    }
    if (type === 'Encounter' && only(keys, 'identifier')) {
      const [system, value] = splitToken(query.identifier!);
      if (system === null || !isEncounterSystem(system, state)) return badSearch();
      const hits = [...state.encounters.values()].filter((e) =>
        e.identifier?.some((i) => i.system === system && i.value === value),
      );
      return bundle(hits, { visitKey: value, businessIdentifier: `${system}|${value}` });
    }
    return badSearch();
  });

  fhir.post('/:type', async (req, reply) => {
    const { type } = req.params as { type: string };
    if (type !== 'Encounter') {
      return send(req, reply, { status: 400, resourceType: type, body: simpleOutcome.build('not-supported', `create of ${type} is not supported`) });
    }
    const body = (req.body ?? {}) as Encounter;
    const violations = validateEncounter(body, { organizationIds: state.organizationIds });
    const identifier = encounterIdentifier(body, state);
    const visitKey = identifier?.value ?? null;
    const businessIdentifier = identifier ? `${identifier.system}|${identifier.value}` : null;
    if (violations.length > 0) {
      return send(req, reply, { status: 400, resourceType: 'Encounter', visitKey, businessIdentifier, body: validationOutcome.build(violations) });
    }
    const id = randomUUID();
    const stored = storedEncounter.build(body, { id, versionId: state.nextVersionId(), lastUpdated: utcNow() });
    state.encounters.set(id, stored);
    return send(req, reply, {
      status: 201,
      resourceType: 'Encounter',
      visitKey,
      businessIdentifier,
      effect: 'created',
      headers: { location: `${baseUrl(req)}/Encounter/${id}/_history/${stored.meta!.versionId}` },
      body: stored,
    });
  });
}

const ENCOUNTER_SYSTEM_PREFIX = 'http://sys-ids.kemkes.go.id/encounter/';

export function isEncounterSystem(system: string, state: MockState): boolean {
  return system.startsWith(ENCOUNTER_SYSTEM_PREFIX) && state.organizationIds.has(system.slice(ENCOUNTER_SYSTEM_PREFIX.length));
}

/** The visit's `encounter/{org}` identifier, if the payload carries one. */
function encounterIdentifier(e: Encounter, state: MockState): { system: string; value: string } | null {
  for (const i of Array.isArray(e.identifier) ? e.identifier : []) {
    if (typeof i?.system === 'string' && typeof i.value === 'string' && isEncounterSystem(i.system, state)) {
      return { system: i.system, value: i.value };
    }
  }
  return null;
}

function splitToken(token: string): [string | null, string] {
  const bar = token.indexOf('|');
  return bar < 0 ? [null, token] : [token.slice(0, bar), token.slice(bar + 1)];
}

function valueFor(token: string, system: string): string | null {
  const [s, v] = splitToken(token);
  return s === system && v !== '' ? v : null;
}

/** `YYYY-MM-DDThh:mm:ss+00:00`, the platform's time format. */
export function utcNow(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

function only(keys: string[], ...allowed: string[]): boolean {
  return keys.length === allowed.length && allowed.every((k) => keys.includes(k));
}

function baseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}/fhir-r4/v1`;
}
