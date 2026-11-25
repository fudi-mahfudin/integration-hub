import { isRealDate } from '../time.js';

/** Checks shared by the payload rules of every resource type (#9). */

/** `YYYY-MM-DDThh:mm:ss+00:00`, exactly (#9). */
const PLATFORM_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;
/** The date floor, `2014-06-03T00:00:00+00:00` (#9). */
export const FLOOR = '2014-06-03T00:00:00+00:00';
/** A FHIR resource id. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

export type Fail = (rule: string, path: string, message: string) => void;

/** A platform time not before the floor; reports TIME_FORMAT or DATE_FLOOR. */
export function checkTime(value: unknown, path: string, fail: Fail): void {
  if (!platformTime(value)) fail('TIME_FORMAT', path, 'must be YYYY-MM-DDThh:mm:ss+00:00');
  // Same fixed-width format, so the strings compare as instants.
  else if (value < FLOOR) fail('DATE_FLOOR', path, `must not be before ${FLOOR}`);
}

export function platformTime(value: unknown): value is string {
  const m = typeof value === 'string' ? PLATFORM_TIME.exec(value) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return isRealDate(y, mo, d) && h < 24 && mi < 60 && s < 60;
}

/** `{ reference: "Type/id" }` with a FHIR id; true when it holds. */
export function reference(ref: any, type: string, path: string, fail: Fail): boolean {
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

export function isObject(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function text(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== '';
}
