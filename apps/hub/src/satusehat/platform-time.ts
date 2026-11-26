/**
 * An instant as SATUSEHAT takes it: `YYYY-MM-DDThh:mm:ss+00:00` in UTC (#9).
 * Fractional seconds are truncated, never rounded, and the date is the UTC
 * date, wherever that falls (08:00+07:00 on 2 March is 01:00 UTC; 05:00+07:00
 * on 1 January is the previous UTC day).
 */
export function platformTime(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new Error('platformTime needs a valid instant, got an invalid Date');
  // toISOString is always UTC `YYYY-MM-DDThh:mm:ss.sssZ` for years 0-9999.
  return `${instant.toISOString().slice(0, 19)}+00:00`;
}
