/**
 * The mock's own Encounter rules (ADR 0006). Written from the rule sources in
 * #2 / #9, never from the hub's code; a disagreement with the hub is a finding.
 * Deliberately stricter than the sandbox.
 */
import type { Violation } from '../templates/outcome.js';

export interface EncounterRuleContext {
  /** Organizations the mock knows; `encounter/{org}` must name one of them. */
  organizationIds: ReadonlySet<string>;
}

const ENCOUNTER_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/encounter\/([^/]+)$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;
/** Dictionary floor, compared in UTC. */
const FLOOR_MS = Date.UTC(2014, 5, 3);
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

/** Epoch ms of a strict `+00:00` time that names a real calendar instant, else null. */
function parseUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = TIME.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  const exact =
    back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d &&
    back.getUTCHours() === h && back.getUTCMinutes() === mi && back.getUTCSeconds() === s;
  return exact ? ms : null;
}

/** Checks `{ reference: "Type/id" }`; returns true when it is present and of the right type. */
function reference(ref: unknown, type: string, path: string, v: (rule: string, path: string, message: string) => void): boolean {
  if (!isObject(ref) || !nonEmpty(ref.reference)) {
    v('REQUIRED', path, `${path.replace(/^Encounter\./, '')} is required`);
    return false;
  }
  const [t, id, ...rest] = String(ref.reference).split('/');
  if (t !== type || !nonEmpty(id) || rest.length > 0) {
    v('REFERENCE_TYPE', path, `must reference a ${type}`);
    return false;
  }
  return true;
}

function isObject(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function nonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== '';
}
