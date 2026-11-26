// The mock's own Encounter validator (ADR 0006): written separately from the
// hub's Validation module and sharing no code with it, so a wrong rule on one
// side shows up as a disagreement instead of passing on both.
import type { Violation } from '../templates/operation-outcome.js';

/** `YYYY-MM-DDThh:mm:ss+00:00`, the only time format the rule dictionary allows. */
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;
/** No submitted date may be earlier than 03 June 2014 (banner on every resource page). */
const DATE_FLOOR = '2014-06-03T00:00:00+00:00';
const DATE_FLOOR_MS = Date.parse(DATE_FLOOR);
const ENCOUNTER_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/encounter\/(\d+)$/;

type Json = Record<string, unknown>;

/**
 * Checks a submitted Encounter against the rules the mock enforces: the
 * mandatory fields (rule dictionary 10117-10124 plus the resource page's
 * stars), `+00:00` times, the date floor, `finished` needing an end after
 * its start (10121), and exactly one `encounter/{org}` identifier, where
 * `{org}` and the serviceProvider are the submitting client's organization
 * (one client maps to one organization). Returns every violation; empty means valid.
 */
export function validateEncounter(body: unknown, clientOrganizationId: string): Violation[] {
  if (!isObject(body)) {
    return [violation('Encounter', `expected a JSON object, got ${describe(body)}`)];
  }
  const violations: Violation[] = [];
  const fail = (path: string, message: string): void => void violations.push(violation(path, message));

  if (body.resourceType !== 'Encounter') {
    fail('Encounter.resourceType', `expected "Encounter", got ${describe(body.resourceType)}`);
  }
  if (!nonEmptyString(body.status)) fail('Encounter.status', 'is required');
  if (!isObject(body.class) || !nonEmptyString(body.class.code) || !nonEmptyString(body.class.system)) {
    fail('Encounter.class', 'is required, with system and code');
  }
  if (!isReferenceTo(body.subject, 'Patient')) {
    fail('Encounter.subject', `must reference "Patient/{ihs}", got ${describe(body.subject)} (10118)`);
  }

  const participants = nonEmptyArray(body.participant);
  if (!participants) fail('Encounter.participant', 'needs at least one participant (10119)');
  participants?.forEach((p, i) => {
    const path = `Encounter.participant[${i}]`;
    if (!isObject(p) || !isReferenceTo(p.individual, 'Practitioner')) {
      fail(`${path}.individual`, 'must reference "Practitioner/{ihs}" (10119)');
    }
    if (isObject(p)) checkPeriod(p.period, `${path}.period`, fail);
  });

  const locations = nonEmptyArray(body.location);
  if (!locations) fail('Encounter.location', 'needs at least one location (10120)');
  locations?.forEach((l, i) => {
    const path = `Encounter.location[${i}]`;
    if (!isObject(l) || !isReferenceTo(l.location, 'Location')) fail(`${path}.location`, 'must reference "Location/{id}" (10120)');
    if (isObject(l)) checkPeriod(l.period, `${path}.period`, fail);
  });

  const history = nonEmptyArray(body.statusHistory);
  if (!history) fail('Encounter.statusHistory', 'needs at least one entry (10122)');
  history?.forEach((h, i) => {
    const path = `Encounter.statusHistory[${i}]`;
    if (!isObject(h) || !nonEmptyString(h.status)) fail(`${path}.status`, 'is required');
    const period = isObject(h) ? h.period : undefined;
    if (!isObject(period) || period.start === undefined) fail(`${path}.period.start`, 'is required');
    checkPeriod(period, `${path}.period`, fail);
  });

  const period = isObject(body.period) ? body.period : undefined;
  if (period?.start === undefined) fail('Encounter.period.start', 'is required (10123)');
  const { start, end } = checkPeriod(period, 'Encounter.period', fail);
  if (body.status === 'finished') {
    if (period?.end === undefined) fail('Encounter.period.end', 'is required when status is "finished" (10121)');
    else if (start !== undefined && end !== undefined && end <= start) {
      fail('Encounter.period.end', `must be later than period.start when status is "finished", got ${describe(period.end)} (10121)`);
    }
  }

  const organizationId = isReferenceTo(body.serviceProvider, 'Organization')
    ? body.serviceProvider.reference.slice('Organization/'.length)
    : undefined;
  if (organizationId === undefined) {
    fail('Encounter.serviceProvider', `must reference "Organization/{org}", got ${describe(body.serviceProvider)} (10124)`);
  } else if (organizationId !== clientOrganizationId) {
    fail('Encounter.serviceProvider', `must be the client's organization "Organization/${clientOrganizationId}", got "Organization/${organizationId}"`);
  }
  checkIdentifier(body.identifier, clientOrganizationId, fail);

  return violations;
}

function checkIdentifier(identifier: unknown, organizationId: string, fail: (path: string, message: string) => void): void {
  const path = 'Encounter.identifier';
  const identifiers = nonEmptyArray(identifier);
  if (!identifiers) return fail(path, 'needs an identifier under http://sys-ids.kemkes.go.id/encounter/{org} (10117)');
  const visitIdentifiers = identifiers.filter((id) => isObject(id) && typeof id.system === 'string' && ENCOUNTER_SYSTEM.test(id.system));
  if (visitIdentifiers.length !== 1) {
    return fail(path, `needs exactly one identifier under http://sys-ids.kemkes.go.id/encounter/{org}, got ${visitIdentifiers.length}`);
  }
  const [visitIdentifier] = visitIdentifiers;
  if (!isObject(visitIdentifier)) return; // narrowed by the filter above
  const system = String(visitIdentifier.system);
  const systemOrg = ENCOUNTER_SYSTEM.exec(system)?.[1];
  if (systemOrg !== organizationId) {
    fail(path, `system "${system}" must be encounter/${organizationId}, the client's organization`);
  }
  if (!nonEmptyString(visitIdentifier.value)) fail(path, 'the encounter/{org} identifier needs a non-empty value');
}

/** Checks the format and floor of a period's start and end; returns them as epoch ms when valid. */
function checkPeriod(
  period: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): { start?: number; end?: number } {
  if (period === undefined) return {};
  if (!isObject(period)) {
    fail(path, `expected an object, got ${describe(period)}`);
    return {};
  }
  const result: { start?: number; end?: number } = {};
  for (const key of ['start', 'end'] as const) {
    if (period[key] === undefined) continue;
    const ms = checkTime(period[key], `${path}.${key}`, fail);
    if (ms !== undefined) result[key] = ms;
  }
  return result;
}

function checkTime(value: unknown, path: string, fail: (path: string, message: string) => void): number | undefined {
  const match = typeof value === 'string' ? UTC_TIME.exec(value) : null;
  if (typeof value !== 'string' || !match) {
    fail(path, `must be YYYY-MM-DDThh:mm:ss+00:00, got ${describe(value)}`);
    return undefined;
  }
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const ms = Date.UTC(y ?? 0, (mo ?? 0) - 1, d ?? 0, h ?? 0, mi ?? 0, s ?? 0);
  const roundTrip = new Date(ms);
  // Date.UTC rolls over impossible values (Feb 30, 24:00); a valid time survives the round trip.
  if (
    roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() + 1 !== mo || roundTrip.getUTCDate() !== d ||
    roundTrip.getUTCHours() !== h || roundTrip.getUTCMinutes() !== mi || roundTrip.getUTCSeconds() !== s
  ) {
    fail(path, `is not a real date and time, got "${value}"`);
    return undefined;
  }
  if (ms < DATE_FLOOR_MS) {
    fail(path, `must not be earlier than ${DATE_FLOOR}, got "${value}"`);
    return undefined;
  }
  return ms;
}

function violation(path: string, message: string): Violation {
  return { code: 'PAYLOAD_INVALID', path, message: `${path} ${message}` };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function nonEmptyArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function isReferenceTo(value: unknown, type: string): value is { reference: string } {
  if (!isObject(value) || typeof value.reference !== 'string') return false;
  return value.reference.startsWith(`${type}/`) && value.reference.length > type.length + 1;
}

function describe(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
