// The hub's PAYLOAD_INVALID rules for an Encounter (#9). Internal to the
// Validation module: callers go through `validateStepPayload`.
import type { OrganizationId } from '../auth/source-systems.js';
import { isObject, isReferenceTo, nonEmptyArray, nonEmptyString, describe, checkTime, type Fail } from './payload-checks.js';

// Written out here, not imported from the builder in satusehat/resources.ts:
// the check must not trust the code it checks.
const ENCOUNTER_SYSTEM_PREFIX = 'http://sys-ids.kemkes.go.id/encounter/';

/**
 * The mandatory fields (rule dictionary 10117-10124 and the resource page's
 * stars), `+00:00` times not before the floor, `finished` needing an end
 * after its start (10121), and exactly one `encounter/{org}` identifier whose
 * `{org}`, like the serviceProvider, is the case's organization.
 */
export function checkEncounter(body: unknown, organizationId: OrganizationId, fail: Fail): void {
  if (!isObject(body)) return fail('Encounter', `must be a JSON object, got ${describe(body)}`);

  if (body.resourceType !== 'Encounter') fail('Encounter.resourceType', `must be "Encounter", got ${describe(body.resourceType)}`);
  checkIdentifier(body.identifier, organizationId, fail);
  if (!nonEmptyString(body.status)) fail('Encounter.status', `is required, got ${describe(body.status)}`);
  if (!isObject(body.class) || !nonEmptyString(body.class.system) || !nonEmptyString(body.class.code)) {
    fail('Encounter.class', `needs a system and a code, got ${describe(body.class)}`);
  }
  if (!isReferenceTo(body.subject, 'Patient')) {
    fail('Encounter.subject', `must reference "Patient/{ihs}", got ${describe(body.subject)} (10118)`);
  }

  const participants = nonEmptyArray(body.participant);
  if (!participants) fail('Encounter.participant', `needs at least one participant, got ${describe(body.participant)} (10119)`);
  participants?.forEach((p, i) => {
    const path = `Encounter.participant[${i}]`;
    const individual = isObject(p) ? p.individual : undefined;
    if (!isReferenceTo(individual, 'Practitioner')) {
      fail(`${path}.individual`, `must reference "Practitioner/{ihs}", got ${describe(individual)} (10119)`);
    }
    if (isObject(p)) checkPeriod(p.period, `${path}.period`, fail);
  });

  const locations = nonEmptyArray(body.location);
  if (!locations) fail('Encounter.location', `needs at least one location, got ${describe(body.location)} (10120)`);
  locations?.forEach((l, i) => {
    const path = `Encounter.location[${i}]`;
    const location = isObject(l) ? l.location : undefined;
    if (!isReferenceTo(location, 'Location')) fail(`${path}.location`, `must reference "Location/{id}", got ${describe(location)} (10120)`);
    if (isObject(l)) checkPeriod(l.period, `${path}.period`, fail);
  });

  const history = nonEmptyArray(body.statusHistory);
  if (!history) fail('Encounter.statusHistory', `needs at least one entry, got ${describe(body.statusHistory)} (10122)`);
  history?.forEach((h, i) => {
    const path = `Encounter.statusHistory[${i}]`;
    const entry = isObject(h) ? h : {};
    if (!nonEmptyString(entry.status)) fail(`${path}.status`, `is required, got ${describe(entry.status)}`);
    const period = isObject(entry.period) ? entry.period : {};
    if (period.start === undefined) fail(`${path}.period.start`, 'is required');
    checkPeriod(entry.period, `${path}.period`, fail);
  });

  const period = isObject(body.period) ? body.period : {};
  if (period.start === undefined) fail('Encounter.period.start', 'is required (10123)');
  const { start, end } = checkPeriod(body.period, 'Encounter.period', fail);
  if (body.status === 'finished') {
    if (period.end === undefined) fail('Encounter.period.end', 'is required when status is "finished" (10121)');
    else if (start !== undefined && end !== undefined && end <= start) {
      fail('Encounter.period.end', `must be later than period.start ${describe(period.start)}, got ${describe(period.end)} (10121)`);
    }
  }

  const expectedProvider = `Organization/${organizationId}`;
  if (!isReferenceTo(body.serviceProvider, 'Organization') || body.serviceProvider.reference !== expectedProvider) {
    fail('Encounter.serviceProvider', `must reference "${expectedProvider}", the case's organization, got ${describe(body.serviceProvider)} (10124)`);
  }
}

function checkIdentifier(identifier: unknown, organizationId: OrganizationId, fail: Fail): void {
  const path = 'Encounter.identifier';
  const expectedSystem = `${ENCOUNTER_SYSTEM_PREFIX}${organizationId}`;
  const identifiers = nonEmptyArray(identifier);
  if (!identifiers) return fail(path, `needs an identifier under ${expectedSystem}, got ${describe(identifier)} (10117)`);
  const visitIdentifiers = identifiers.filter(
    (id) => isObject(id) && typeof id.system === 'string' && id.system.startsWith(ENCOUNTER_SYSTEM_PREFIX),
  );
  const [only] = visitIdentifiers;
  if (visitIdentifiers.length !== 1 || !isObject(only)) {
    return fail(path, `needs exactly one identifier under ${ENCOUNTER_SYSTEM_PREFIX}{org}, got ${visitIdentifiers.length}`);
  }
  if (only.system !== expectedSystem) fail(path, `system must be ${expectedSystem}, the case's organization, got ${describe(only.system)}`);
  if (!nonEmptyString(only.value)) fail(path, `the ${expectedSystem} identifier needs a value, got ${describe(only.value)}`);
}

/** Checks a period's start and end, where present; returns the valid ones as epoch ms. */
function checkPeriod(period: unknown, path: string, fail: Fail): { start?: number; end?: number } {
  if (period === undefined) return {};
  if (!isObject(period)) {
    fail(path, `must be an object, got ${describe(period)}`);
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
