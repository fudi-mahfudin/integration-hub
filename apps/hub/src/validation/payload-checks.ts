// Field checks shared by the Validation module's payload rules. Internal to the module.
import type { OrganizationId } from '../auth/source-systems.js';

/** Records one PAYLOAD_INVALID violation at `path`. */
export type Fail = (path: string, message: string) => void;

/** `YYYY-MM-DDThh:mm:ss+00:00`, the only time format SATUSEHAT's rule dictionary allows (#9). */
const PLATFORM_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;

/** The date floor: nothing submitted may be earlier (#9). */
const DATE_FLOOR = '2014-06-03T00:00:00+00:00';
/** The date floor as a plain date, for dates SATUSEHAT takes without a time, such as a batch expiry. */
const DATE_FLOOR_DAY = DATE_FLOOR.slice(0, 10);
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_FLOOR_MS = Date.parse(DATE_FLOOR);

/** Checks a platform time and the floor; returns it as epoch ms when valid. */
export function checkTime(value: unknown, path: string, fail: Fail): number | undefined {
  const match = typeof value === 'string' ? PLATFORM_TIME.exec(value) : null;
  if (!match) {
    fail(path, `must be YYYY-MM-DDThh:mm:ss+00:00, got ${describe(value)}`);
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year ?? NaN, (month ?? NaN) - 1, day ?? NaN, hour, minute, second);
  // Date.UTC rolls impossible values over (30 February, 24:00); a real time reads back the same.
  if (new Date(ms).toISOString().slice(0, 19) !== String(value).slice(0, 19)) {
    fail(path, `must be a real date and time, got ${describe(value)}`);
    return undefined;
  }
  if (ms < DATE_FLOOR_MS) {
    fail(path, `must not be earlier than ${DATE_FLOOR}, got ${describe(value)}`);
    return undefined;
  }
  return ms;
}

/** Checks a plain date `YYYY-MM-DD` that is real and not before the floor's date. */
export function checkPlainDate(value: unknown, path: string, fail: Fail): void {
  const ms = typeof value === 'string' && PLAIN_DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  // Date.parse rejects month 13 (NaN) but rolls 30 February over; a real date reads back the same.
  const real = typeof value === 'string' && !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
  if (!real) return fail(path, `must be a real date YYYY-MM-DD, got ${describe(value)}`);
  // Both are YYYY-MM-DD, so they compare as strings.
  if (value < DATE_FLOOR_DAY) fail(path, `must not be earlier than ${DATE_FLOOR_DAY}, got ${describe(value)}`);
}

/** A JSON object (not an array, not null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string with something other than whitespace. */
export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The array when it has at least one element. */
export function nonEmptyArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

/** A FHIR reference `{ reference: "{type}/{id}" }` with a non-empty id. */
export function isReferenceTo(value: unknown, type: string): value is { reference: string } {
  return isObject(value) && typeof value.reference === 'string' && value.reference.startsWith(`${type}/`) && value.reference.length > type.length + 1;
}

/** A value as a message shows it. */
export function describe(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

/**
 * Checks that `identifier` holds exactly one business identifier under
 * `{prefix}{org}` (any organization's), that it is the case organization's,
 * and that it has a value. `path` names the identifier element.
 */
export function checkBusinessIdentifier(identifier: unknown, path: string, prefix: string, organizationId: OrganizationId, fail: Fail): void {
  const expectedSystem = `${prefix}${organizationId}`;
  const matching = (nonEmptyArray(identifier) ?? []).filter(
    (id) => isObject(id) && typeof id.system === 'string' && id.system.startsWith(prefix) && /^\d+$/.test(id.system.slice(prefix.length)),
  );
  const [only] = matching;
  if (matching.length !== 1 || !isObject(only)) return fail(path, `needs exactly one identifier under ${prefix}{org}, got ${matching.length}`);
  if (only.system !== expectedSystem) fail(path, `system must be ${expectedSystem}, the case's organization, got ${describe(only.system)}`);
  if (!nonEmptyString(only.value)) fail(path, `the ${expectedSystem} identifier needs a value, got ${describe(only.value)}`);
}

/** The coding system of KFA codes. Written out here, not imported from the builder: the check must not trust the code it checks. */
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';

/**
 * The contained Medication `body.medicationReference` points at, checked to
 * be coded by KFA; undefined (with the violation recorded) when there is none.
 */
export function containedMedication(body: Record<string, unknown>, resourceType: string, fail: Fail): Record<string, unknown> | undefined {
  const path = `${resourceType}.medicationReference`;
  const reference = isObject(body.medicationReference) ? body.medicationReference.reference : undefined;
  if (typeof reference !== 'string' || !reference.startsWith('#')) {
    fail(path, `must reference a contained Medication ("#{id}"), got ${describe(body.medicationReference)}`);
    return undefined;
  }
  const medication = (nonEmptyArray(body.contained) ?? []).find(
    (c) => isObject(c) && c.resourceType === 'Medication' && c.id === reference.slice(1),
  );
  if (!isObject(medication)) {
    fail(path, `references ${describe(reference)}, which is not a contained Medication`);
    return undefined;
  }
  const codings = isObject(medication.code) ? (nonEmptyArray(medication.code.coding) ?? []) : [];
  if (!codings.some((c) => isObject(c) && c.system === KFA_SYSTEM && nonEmptyString(c.code))) {
    fail(`${resourceType}.contained.Medication.code`, `needs a coding under ${KFA_SYSTEM}, got ${describe(medication.code)}`);
  }
  return medication;
}
