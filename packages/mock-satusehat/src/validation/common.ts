/**
 * Helpers shared by the mock's own validation rules. Mock-internal: never
 * imported from or by the hub (ADR 0006).
 */

/** The strict platform time: `YYYY-MM-DDThh:mm:ss+00:00`. */
export const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;

/** The date floor, 2014-06-03T00:00:00+00:00, in epoch ms. */
export const FLOOR_MS = Date.UTC(2014, 5, 3);

/** Reports one violation of a mock rule. */
export type Report = (rule: string, path: string, message: string) => void;

/** Epoch ms of a strict `+00:00` time that names a real calendar instant, else null. */
export function parseUtc(value: unknown): number | null {
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

/**
 * Checks `{ reference: "Type/id" }` at `path` (which starts with the
 * resource type); returns true when it is present and of the right type.
 */
export function reference(ref: unknown, type: string, path: string, v: Report): boolean {
  if (!isObject(ref) || !nonEmpty(ref.reference)) {
    v('REQUIRED', path, `${path.replace(/^[A-Za-z]+\./, '')} is required`);
    return false;
  }
  const [t, id, ...rest] = String(ref.reference).split('/');
  if (t !== type || !nonEmpty(id) || rest.length > 0) {
    v('REFERENCE_TYPE', path, `must reference a ${type}`);
    return false;
  }
  return true;
}

export function isObject(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function nonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== '';
}
