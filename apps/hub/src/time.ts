/** Source times in, platform times out (#9). */

/** Full date-time with seconds and fraction optional, and an explicit offset (`Z` allowed). */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
/** A date-time, or any leading part of one, without an offset: naive or partial. */
const NO_OFFSET = /^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?)?)?)?$/;

export type ParsedTime = { ok: true; instant: Date } | { ok: false; reason: 'offset_missing' | 'invalid' };

/**
 * Parses a source time (ISO 8601 with an explicit offset) to its instant.
 * Computed by hand rather than `new Date(text)`, whose parsing of fractions
 * and hh:mm forms is implementation-defined. Sub-millisecond digits are dropped.
 */
export function parseSourceTime(text: string): ParsedTime {
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

/**
 * The platform's time format: `YYYY-MM-DDThh:mm:ss+00:00`, never `Z`,
 * fractional seconds truncated (not rounded); the UTC date falls where it
 * falls (#9).
 */
export function toPlatformTime(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}+00:00`;
}

/** A source time already accepted by ingest, in the platform's format. */
export function sourceToPlatformTime(text: string): string {
  const parsed = parseSourceTime(text);
  if (!parsed.ok) throw new Error(`stored source time is not valid: ${parsed.reason}`);
  return toPlatformTime(parsed.instant);
}

export function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
