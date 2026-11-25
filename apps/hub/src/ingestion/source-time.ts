/** Times as the source system sends them (#9). */

/** Full date-time, seconds and fraction optional, with an explicit offset (`Z` allowed). */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
/** A date-time, or any leading part of one, without an offset: naive or partial. */
const NO_OFFSET = /^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?)?)?)?$/;
/** A plain calendar date. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The date floor: no source time may fall before it, compared on the UTC
 * value (#9), so `2014-06-03T05:00:00+07:00` is too early.
 */
export const DATE_FLOOR = new Date('2014-06-03T00:00:00+00:00');

/** A parsed source time: its instant, or why it isn't one. */
export type ParsedSourceTime = { ok: true; instant: Date } | { ok: false; reason: 'offset_missing' | 'invalid' };

/**
 * Parses a source time (ISO 8601 with an explicit offset) to its instant.
 * Computed by hand rather than `new Date(text)`, whose parsing of fractions
 * and offsets beyond the strict ISO subset is implementation-defined.
 * Sub-millisecond digits are dropped.
 */
export function parseSourceTime(text: string): ParsedSourceTime {
  const m = DATE_TIME.exec(text);
  if (!m) return { ok: false, reason: NO_OFFSET.test(text) ? 'offset_missing' : 'invalid' };
  const [, y, mo, d, h, mi, s = '0', fraction = '0', , sign = '+', oh = '0', om = '0'] = m;
  const valid =
    isRealDate(Number(y), Number(mo), Number(d)) &&
    Number(h) < 24 &&
    Number(mi) < 60 &&
    Number(s) < 60 &&
    Number(oh) <= 14 &&
    Number(om) < 60;
  if (!valid) return { ok: false, reason: 'invalid' };
  const offsetMs = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000;
  const ms = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  return { ok: true, instant: new Date(local - offsetMs) };
}

/** Whether `text` is a real calendar date written `YYYY-MM-DD`. */
export function isCalendarDate(text: string): boolean {
  const m = DATE.exec(text);
  return m !== null && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
