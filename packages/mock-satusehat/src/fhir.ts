import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Resource } from 'fhir/r4.js';
import { encounterIdentifier, isEncounterSystem, isPrescriptionSystem, prescriptionIdentifier, resourceIdentity } from './identity.js';
import { respond, type Outcome } from './server.js';
import type { MockState } from './state.js';
import {
  locationResource,
  NIK_SYSTEM,
  patientResource,
  practitionerResource,
  searchBundle,
  simpleOutcome,
  storedResource,
  validationOutcome,
  type Violation,
} from './templates/index.js';
import { validateEncounter, validateEncounterUpdate } from './validation/encounter.js';
import { validateMedicationDispense } from './validation/medication-dispense.js';
import { validateMedicationRequest } from './validation/medication-request.js';

type Query = Record<string, string | undefined>;

export function registerFhirRoutes(fhir: FastifyInstance, state: MockState): void {
  const send = (req: FastifyRequest, reply: FastifyReply, o: Outcome) => respond(state, req, reply, o);
  const visitOf = (r: Resource) => resourceIdentity(r, state);

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
    if ((type === 'MedicationRequest' || type === 'MedicationDispense') && only(keys, 'identifier')) {
      const [system, value] = splitToken(query.identifier!);
      if (system === null || !isPrescriptionSystem(system, state)) return badSearch();
      const hits = [...state.recordsOf(type).values()].filter((r) => {
        const i = prescriptionIdentifier(r);
        return i?.system === system && i.value === value;
      });
      return bundle(hits);
    }
    return badSearch();
  });

  fhir.get('/:type/:id', async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const record = state.recordsOf(type).get(id);
    if (!record) return send(req, reply, notFound(type, id));
    return send(req, reply, { status: 200, resourceType: type, ...visitOf(record), body: record });
  });

  // Update: 404 for a missing or deleted record, validated (only Encounter is
  // updatable: the update visit step), an applied one bumps versionId (#12).
  fhir.put('/:type/:id', async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const records = state.recordsOf(type);
    const existing = records.get(id);
    if (!existing) return send(req, reply, notFound(type, id));
    const body = (req.body ?? {}) as Resource;
    if (type !== 'Encounter') {
      return send(req, reply, { status: 400, resourceType: type, ...visitOf(existing), body: simpleOutcome.build('not-supported', `update of ${type} is not supported`) });
    }
    const violations = validateEncounterUpdate(body, id, existing as Record<string, any>, { organizationIds: state.organizationIds });
    if (violations.length > 0) {
      return send(req, reply, { status: 400, resourceType: type, ...visitOf(existing), body: validationOutcome.build(violations) });
    }
    const stored = { ...body, id, meta: { versionId: state.nextVersionId(), lastUpdated: utcNow() } } as Resource;
    records.set(id, stored);
    return send(req, reply, { status: 200, resourceType: type, ...visitOf(stored), effect: 'updated', body: stored });
  });

  fhir.post('/:type', async (req, reply) => {
    const { type } = req.params as { type: string };
    const validate = VALIDATORS[type];
    if (!validate) {
      return send(req, reply, { status: 400, resourceType: type, body: simpleOutcome.build('not-supported', `create of ${type} is not supported`) });
    }
    const body = (req.body ?? {}) as Resource;
    const { visitKey, businessIdentifier } = visitOf({ ...body, resourceType: type } as Resource);
    const violations = validate(body, state);
    if (violations.length > 0) {
      return send(req, reply, { status: 400, resourceType: type, visitKey, businessIdentifier, body: validationOutcome.build(violations) });
    }
    const id = randomUUID();
    const stored = storedResource.build(type, body, { id, versionId: state.nextVersionId(), lastUpdated: utcNow() });
    state.recordsOf(type).set(id, stored);
    return send(req, reply, {
      status: 201,
      resourceType: type,
      visitKey,
      businessIdentifier,
      effect: 'created',
      headers: { location: `${baseUrl(req)}/${type}/${id}/_history/${stored.meta!.versionId}` },
      body: stored,
    });
  });
}

/** Creatable resource types and the mock's own rules for each (ADR 0006). */
const VALIDATORS: Record<string, (body: unknown, state: MockState) => Violation[]> = {
  Encounter: (body, state) => validateEncounter(body, { organizationIds: state.organizationIds }),
  MedicationRequest: (body, state) =>
    validateMedicationRequest(body, {
      organizationIds: state.organizationIds,
      kfaByCode: state.kfaByCode,
      hasEncounter: (id) => state.encounters.has(id),
    }),
  MedicationDispense: (body, state) =>
    validateMedicationDispense(body, {
      organizationIds: state.organizationIds,
      kfaByCode: state.kfaByCode,
      hasEncounter: (id) => state.encounters.has(id),
      medicationRequest: (id) => state.recordsOf('MedicationRequest').get(id) as Record<string, any> | undefined,
    }),
};

export { isEncounterSystem };

function notFound(type: string, id: string): Outcome {
  return { status: 404, resourceType: type, body: simpleOutcome.build('not-found', `${type}/${id} not found`) };
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
