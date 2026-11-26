// Field checks shared by the Validation module's payload rules. Internal to the module.

/** Records one PAYLOAD_INVALID violation at `path`. */
export type Fail = (path: string, message: string) => void;

/** `YYYY-MM-DDThh:mm:ss+00:00`, the only time format SATUSEHAT's rule dictionary allows (#9). */
const PLATFORM_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;

/** The date floor: nothing submitted may be earlier (#9). */
const DATE_FLOOR = '2014-06-03T00:00:00+00:00';
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
