/**
 * The mock's own Encounter rules (ADR 0006). Written from the rule sources in
 * #2 / #9, never from the hub's code; a disagreement with the hub is a finding.
 * Deliberately stricter than the sandbox.
 */
import type { Violation } from '../templates/outcome.js';
import { FLOOR_MS, isObject, nonEmpty, parseUtc, reference } from './common.js';

export interface EncounterRuleContext {
  /** Organizations the mock knows; `encounter/{org}` must name one of them. */
  organizationIds: ReadonlySet<string>;
}

const ENCOUNTER_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/encounter\/([^/]+)$/;
const STATUSES = new Set(['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown']);

const STEP_CODE = 'PAYLOAD_INVALID';

export function validateEncounter(body: unknown, ctx: EncounterRuleContext): Violation[] {
  const out: Violation[] = [];
  const v = (rule: string, path: string, message: string) => out.push({ code: STEP_CODE, rule, path, message });
  const e = (isObject(body) ? body : {}) as Record<string, any>;

  if (e.resourceType !== 'Encounter') v('RESOURCE_TYPE', 'Encounter.resourceType', 'resourceType must be Encounter');

  // identifier: encounter/{org} with a value
  const identifiers: any[] = Array.isArray(e.identifier) ? e.identifier : [];
  let org: string | null = null;
  if (identifiers.length === 0) {
    v('REQUIRED', 'Encounter.identifier', 'identifier is required');
  } else {
    const match = identifiers.find((i) => typeof i?.system === 'string' && ENCOUNTER_SYSTEM.test(i.system));
    const matchOrg = match ? ENCOUNTER_SYSTEM.exec(match.system)![1]! : null;
    if (!match || matchOrg === null || !ctx.organizationIds.has(matchOrg)) {
      v('IDENTIFIER_SYSTEM', 'Encounter.identifier', 'identifier system must be http://sys-ids.kemkes.go.id/encounter/{organization id}');
    } else if (!nonEmpty(match.value)) {
      v('REQUIRED', 'Encounter.identifier', 'identifier value is required');
    } else {
      org = matchOrg;
    }
  }

  if (!nonEmpty(e.status)) v('REQUIRED', 'Encounter.status', 'status is required');
  else if (!STATUSES.has(e.status)) v('VALUE_SET', 'Encounter.status', `status ${String(e.status)} is not in the FHIR EncounterStatus value set`);

  if (!isObject(e.class)) v('REQUIRED', 'Encounter.class', 'class is required');
  else if (!nonEmpty(e.class.code)) v('REQUIRED', 'Encounter.class.code', 'class.code is required');

  reference(e.subject, 'Patient', 'Encounter.subject.reference', v);

  const participants: any[] = Array.isArray(e.participant) ? e.participant : [];
  if (participants.length === 0) v('REQUIRED', 'Encounter.participant', 'at least one participant is required');
  participants.forEach((p, i) => reference(p?.individual, 'Practitioner', `Encounter.participant[${i}].individual.reference`, v));

  if (!isObject(e.period) || e.period.start === undefined) v('REQUIRED', 'Encounter.period.start', 'period.start is required');

  const locations: any[] = Array.isArray(e.location) ? e.location : [];
  if (locations.length === 0) v('REQUIRED', 'Encounter.location', 'at least one location is required');
  locations.forEach((l, i) => reference(l?.location, 'Location', `Encounter.location[${i}].location.reference`, v));

  if (reference(e.serviceProvider, 'Organization', 'Encounter.serviceProvider.reference', v) && org !== null) {
    if (e.serviceProvider.reference !== `Organization/${org}`) {
      v('ORGANIZATION_MISMATCH', 'Encounter.serviceProvider.reference', 'serviceProvider must be the organization of the encounter identifier');
    }
  }

  // every time field: format, then floor
  for (const [path, value] of timeFields(e)) {
    const ms = parseUtc(value);
    if (ms === null) v('TIME_FORMAT', path, 'time must be YYYY-MM-DDThh:mm:ss+00:00');
    else if (ms < FLOOR_MS) v('DATE_FLOOR', path, 'time must not be before 2014-06-03T00:00:00+00:00');
  }

  // Dictionary rule 10121: a visit ends after it starts.
  if (isObject(e.period) && e.period.end !== undefined) {
    const start = parseUtc(e.period.start);
    const end = parseUtc(e.period.end);
    if (start !== null && end !== null && end <= start) v('PERIOD_ORDER', 'Encounter.period.end', 'period.end must be after period.start');
  }

  return out;
}

/**
 * An update (`PUT /Encounter/{id}`) of the stored record: every create rule,
 * plus FHIR's update rule (the body's `id` is the URL's), the visit's
 * identifier unchanged, and a `finished` visit has an end time.
 */
export function validateEncounterUpdate(body: unknown, id: string, stored: Record<string, any>, ctx: EncounterRuleContext): Violation[] {
  const out = validateEncounter(body, ctx);
  const v = (rule: string, path: string, message: string) => out.push({ code: STEP_CODE, rule, path, message });
  const e = (isObject(body) ? body : {}) as Record<string, any>;

  if (e.id !== id) v('ID_MISMATCH', 'Encounter.id', 'the body id must be the id in the URL');

  const own = (stored.identifier ?? []).find((i: any) => typeof i?.system === 'string' && ENCOUNTER_SYSTEM.test(i.system));
  const identifiers: any[] = Array.isArray(e.identifier) ? e.identifier : [];
  if (own && !identifiers.some((i) => i?.system === own.system && i?.value === own.value)) {
    v('IDENTIFIER_CHANGED', 'Encounter.identifier', `an update must keep the identifier ${own.system}|${own.value}`);
  }

  if (e.status === 'finished' && (!isObject(e.period) || e.period.end === undefined)) {
    v('REQUIRED', 'Encounter.period.end', 'a finished Encounter needs period.end');
  }
  return out;
}

function timeFields(e: Record<string, any>): [string, unknown][] {
  const out: [string, unknown][] = [];
  const period = (p: unknown, path: string) => {
    if (!isObject(p)) return;
    if (p.start !== undefined) out.push([`${path}.start`, p.start]);
    if (p.end !== undefined) out.push([`${path}.end`, p.end]);
  };
  period(e.period, 'Encounter.period');
  (Array.isArray(e.location) ? e.location : []).forEach((l: any, i: number) => period(l?.period, `Encounter.location[${i}].period`));
  (Array.isArray(e.statusHistory) ? e.statusHistory : []).forEach((s: any, i: number) => period(s?.period, `Encounter.statusHistory[${i}].period`));
  return out;
}
