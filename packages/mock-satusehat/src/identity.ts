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

  let visit: { system: string; value: string } | null = null;
  if (resourceType !== null && id !== undefined) {
    const stored = state.recordsOf(resourceType).get(id);
    if (stored) visit = encounterIdentifier(stored, state);
  }
  if (visit === null && req.body !== null && typeof req.body === 'object') visit = encounterIdentifier(req.body as Resource, state);
  const identifierQuery = url.searchParams.get('identifier');
  if (visit === null && resourceType === 'Encounter' && identifierQuery !== null) {
    const bar = identifierQuery.indexOf('|');
    const system = bar < 0 ? '' : identifierQuery.slice(0, bar);
    if (isEncounterSystem(system, state)) visit = { system, value: identifierQuery.slice(bar + 1) };
  }

  const businessIdentifier = visit ? `${visit.system}|${visit.value}` : null;
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const fallback = `${path}?${new URLSearchParams(params)}`;
  return { resourceType, visitKey: visit?.value ?? null, businessIdentifier, faultKey: businessIdentifier ?? fallback };
}
