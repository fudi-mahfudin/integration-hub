import type { Encounter, Resource } from 'fhir/r4.js';
import type { MockState } from './state.js';

const ENCOUNTER_SYSTEM_PREFIX = 'http://sys-ids.kemkes.go.id/encounter/';
const FHIR_PREFIX = '/fhir-r4/v1/';

export function isEncounterSystem(system: string, state: MockState): boolean {
  return system.startsWith(ENCOUNTER_SYSTEM_PREFIX) && state.organizationIds.has(system.slice(ENCOUNTER_SYSTEM_PREFIX.length));
}

/** The visit's `encounter/{org}` identifier, if the resource carries one. */
export function encounterIdentifier(e: Pick<Encounter, 'identifier'> | Resource, state: MockState): { system: string; value: string } | null {
  const ids = (e as Encounter).identifier;
  for (const i of Array.isArray(ids) ? ids : []) {
    if (typeof i?.system === 'string' && typeof i.value === 'string' && isEncounterSystem(i.system, state)) {
      return { system: i.system, value: i.value };
    }
  }
  return null;
}

const PRESCRIPTION_SYSTEM_PREFIX = 'http://sys-ids.kemkes.go.id/prescription/';

export function isPrescriptionSystem(system: string, state: MockState): boolean {
  return system.startsWith(PRESCRIPTION_SYSTEM_PREFIX) && state.organizationIds.has(system.slice(PRESCRIPTION_SYSTEM_PREFIX.length));
}

/** A MedicationRequest's `prescription/{org}` identifier, if it carries one. */
export function prescriptionIdentifier(r: Resource): { system: string; value: string } | null {
  const ids = (r as { identifier?: { system?: unknown; value?: unknown }[] }).identifier;
  for (const i of Array.isArray(ids) ? ids : []) {
    if (typeof i?.system === 'string' && typeof i.value === 'string' && i.system.startsWith(PRESCRIPTION_SYSTEM_PREFIX)) {
      return { system: i.system, value: i.value };
    }
  }
  return null;
}

/** Resource types identified by `prescription/{org}`: the prescription and its dispense (#9). */
const PRESCRIPTION_TYPES = new Set(['MedicationRequest', 'MedicationDispense']);

/**
 * The visit a resource belongs to (#12): an Encounter's own identifier, or for
 * a MedicationRequest (`encounter`) or MedicationDispense (`context`) the
 * identifier of the Encounter it references.
 */
export function visitIdentifier(r: Resource, state: MockState): { system: string; value: string } | null {
  const own = encounterIdentifier(r, state);
  if (own) return own;
  const link = r.resourceType === 'MedicationDispense' ? (r as { context?: unknown }).context : (r as { encounter?: unknown }).encounter;
  const ref = (link as { reference?: unknown } | undefined)?.reference;
  if (typeof ref !== 'string' || !ref.startsWith('Encounter/')) return null;
  const encounter = state.encounters.get(ref.slice('Encounter/'.length));
  return encounter ? encounterIdentifier(encounter, state) : null;
}

/** Who a resource is about: its visit and its business identifier (`encounter/{org}` or `prescription/{org}`). */
export function resourceIdentity(r: Resource, state: MockState): { visitKey: string | null; businessIdentifier: string | null } {
  const visit = visitIdentifier(r, state);
  const business = PRESCRIPTION_TYPES.has(r.resourceType) ? prescriptionIdentifier(r) : visit;
  return { visitKey: visit?.value ?? null, businessIdentifier: business ? `${business.system}|${business.value}` : null };
}

export interface RequestIdentity {
  resourceType: string | null;
  visitKey: string | null;
  businessIdentifier: string | null;
  /** What fault decisions hash and count on: the business identifier, else a stable request description. */
  faultKey: string;
}

/**
 * Who a request is about, worked out before any handler runs, so faults can
 * be decided and logged. Never uses server-assigned ids (they are random),
 * so the same request meets the same fate in every run.
 */
export function requestIdentity(
  req: { method: string; url: string; body?: unknown },
  state: MockState,
): RequestIdentity {
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname;
  const [type, id] = path.startsWith(FHIR_PREFIX) ? path.slice(FHIR_PREFIX.length).split('/') : [];
  const resourceType = type && /^[A-Za-z]+$/.test(type) ? type : null;

  let found: { visitKey: string | null; businessIdentifier: string | null } = { visitKey: null, businessIdentifier: null };
  if (resourceType !== null && id !== undefined) {
    const stored = state.recordsOf(resourceType).get(id);
    if (stored) found = resourceIdentity(stored, state);
  }
  if (found.businessIdentifier === null && req.body !== null && typeof req.body === 'object') {
    found = resourceIdentity({ resourceType: resourceType ?? '', ...(req.body as object) } as Resource, state);
  }
  const identifierQuery = url.searchParams.get('identifier');
  if (found.businessIdentifier === null && identifierQuery !== null) {
    const bar = identifierQuery.indexOf('|');
    const system = bar < 0 ? '' : identifierQuery.slice(0, bar);
    const value = identifierQuery.slice(bar + 1);
    if (resourceType === 'Encounter' && isEncounterSystem(system, state)) found = { visitKey: value, businessIdentifier: identifierQuery };
    if (resourceType !== null && PRESCRIPTION_TYPES.has(resourceType) && isPrescriptionSystem(system, state)) {
      // The visit of a record of this type the mock already holds, if any.
      const held = [...state.recordsOf(resourceType).values()].find((r) => prescriptionIdentifier(r)?.value === value && prescriptionIdentifier(r)?.system === system);
      found = { visitKey: held ? resourceIdentity(held, state).visitKey : null, businessIdentifier: identifierQuery };
    }
  }

  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const fallback = `${path}?${new URLSearchParams(params)}`;
  return { resourceType, ...found, faultKey: found.businessIdentifier ?? fallback };
}
