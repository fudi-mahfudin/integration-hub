import { isRealDate } from '../time.js';
import type { Violation } from './validation.js';

/** Encounter payload rules (#9: mandatory fields, time format, floor, identifier systems). */

const ENCOUNTER_STATUSES = ['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled'];
const ACT_CODE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const ENCOUNTER_CLASSES = ['AMB', 'IMP', 'EMER'];

/** `YYYY-MM-DDThh:mm:ss+00:00`, exactly (#9). */
const PLATFORM_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;
/** The date floor, `2014-06-03T00:00:00+00:00` (#9). */
const FLOOR = '2014-06-03T00:00:00+00:00';
/** A FHIR resource id. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

export function encounterRules(e: Record<string, any>, organizationId: string): Violation[] {
  const out: Violation[] = [];
  const fail = (rule: string, path: string, message: string) => out.push({ code: 'PAYLOAD_INVALID', rule, path, message });
  const system = `http://sys-ids.kemkes.go.id/encounter/${organizationId}`;

  const identifiers: any[] = Array.isArray(e.identifier) ? e.identifier : [];
  const own = identifiers.findIndex((i) => i?.system === system);
  if (identifiers.length === 0) fail('REQUIRED', 'Encounter.identifier', 'identifier is required');
  else if (own < 0) fail('IDENTIFIER_SYSTEM', 'Encounter.identifier', `needs an identifier with system ${system}`);
  else if (!text(identifiers[own].value)) fail('REQUIRED', `Encounter.identifier[${own}].value`, 'identifier value is required');

  if (!text(e.status)) fail('REQUIRED', 'Encounter.status', 'status is required');
  else if (!ENCOUNTER_STATUSES.includes(e.status)) fail('VALUE_SET', 'Encounter.status', `status ${e.status} is not allowed`);

  if (!isObject(e.class)) fail('REQUIRED', 'Encounter.class', 'class is required');
  else if (e.class.system !== ACT_CODE_SYSTEM) fail('VALUE_SET', 'Encounter.class.system', `class system must be ${ACT_CODE_SYSTEM}`);
  else if (!ENCOUNTER_CLASSES.includes(e.class.code)) fail('VALUE_SET', 'Encounter.class.code', `class code must be one of ${ENCOUNTER_CLASSES.join(', ')}`);

  reference(e.subject, 'Patient', 'Encounter.subject.reference', fail);

  const participants: any[] = Array.isArray(e.participant) ? e.participant : [];
  if (participants.length === 0) fail('REQUIRED', 'Encounter.participant', 'a participant is required');
  participants.forEach((p, i) => reference(p?.individual, 'Practitioner', `Encounter.participant[${i}].individual.reference`, fail));

  if (!isObject(e.period) || e.period.start === undefined) fail('REQUIRED', 'Encounter.period.start', 'period.start is required');

  const locations: any[] = Array.isArray(e.location) ? e.location : [];
  if (locations.length === 0) fail('REQUIRED', 'Encounter.location', 'a location is required');
  locations.forEach((l, i) => reference(l?.location, 'Location', `Encounter.location[${i}].location.reference`, fail));

  if (reference(e.serviceProvider, 'Organization', 'Encounter.serviceProvider.reference', fail)) {
    if (e.serviceProvider.reference !== `Organization/${organizationId}`) {
      fail('IDENTIFIER_SYSTEM', 'Encounter.serviceProvider.reference', `serviceProvider must be Organization/${organizationId}`);
    }
  }

  for (const [path, value] of times(e)) {
    if (!platformTime(value)) fail('TIME_FORMAT', path, 'must be YYYY-MM-DDThh:mm:ss+00:00');
    // Same fixed-width format, so the strings compare as instants.
    else if (value < FLOOR) fail('DATE_FLOOR', path, `must not be before ${FLOOR}`);
  }
  return out;
}

/** Every time field of an Encounter, with its path. */
function times(e: Record<string, any>): [string, unknown][] {
  const out: [string, unknown][] = [];
  const period = (p: any, path: string) => {
    if (!isObject(p)) return;
    if (p.start !== undefined) out.push([`${path}.start`, p.start]);
    if (p.end !== undefined) out.push([`${path}.end`, p.end]);
  };
  period(e.period, 'Encounter.period');
  (Array.isArray(e.location) ? e.location : []).forEach((l: any, i: number) => period(l?.period, `Encounter.location[${i}].period`));
  (Array.isArray(e.statusHistory) ? e.statusHistory : []).forEach((s: any, i: number) =>
    period(s?.period, `Encounter.statusHistory[${i}].period`),
  );
  return out;
}

function platformTime(value: unknown): value is string {
  const m = typeof value === 'string' ? PLATFORM_TIME.exec(value) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return isRealDate(y, mo, d) && h < 24 && mi < 60 && s < 60;
}

/** `{ reference: "Type/id" }` with a FHIR id; true when it holds. */
function reference(ref: any, type: string, path: string, fail: (rule: string, path: string, message: string) => void): boolean {
  if (!isObject(ref) || !text(ref.reference)) {
    fail('REQUIRED', path, 'reference is required');
    return false;
  }
  const [t, id, ...rest] = String(ref.reference).split('/');
  if (t !== type || id === undefined || !FHIR_ID.test(id) || rest.length > 0) {
    fail('REFERENCE', path, `must be ${type}/{id}`);
    return false;
  }
  return true;
}

function isObject(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function text(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== '';
}
