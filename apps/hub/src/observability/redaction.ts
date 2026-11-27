// The one redaction module (#15, #40): everything a log line carries passes
// through `redact` centrally, in the logger; call sites never redact.

/** A key as the key lists compare it: lower case, letters and digits only. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** What a redacted value is replaced with. */
export const REDACTED = '[REDACTED]';

/**
 * The one key list: a value under any of these keys (compared ignoring case
 * and separators, so `birth_date` matches `birthDate`)
 * is replaced whole, at any depth. Personal data (NIKs, names, IHS numbers,
 * birth date, gender, address, phone).
 */
const REDACTED_KEYS = new Set(
  [
    'nik',
    'motherNik',
    'name',
    'given',
    'family',
    'birthDate',
    'gender',
    'address',
    'phone',
    'telecom',
    'ihsNumber',
    'patientIhsNumber',
    'practitionerIhsNumber',
    'requesterIhsNumber',
    'pharmacistIhsNumber',
  ].map(normalizeKey),
);

/**
 * Shapes scrubbed out of every string, whatever its key: a run of 16 or more
 * digits (a NIK), a patient IHS number (`P` + 11 digits), and a practitioner
 * IHS number (11 digits starting with 1, or `N` + 8 digits). Not a letter or
 * digit on either side, so 8-digit KFA codes and UUIDs are untouched.
 */
const SCRUBBED_PATTERN = /\d{16,}|(?<![A-Za-z0-9])(?:P\d{11}|1\d{10}|N\d{8})(?![A-Za-z0-9])/g;

/** `text` with every NIK and IHS-number shape replaced by `REDACTED`. */
export function scrub(text: string): string {
  return text.replace(SCRUBBED_PATTERN, REDACTED);
}

/**
 * Keys whose values are never logged at all, not even as `REDACTED`: bodies
 * (source events, FHIR requests and responses, OperationOutcomes) and
 * `visitId`, which the case view and the rejection log hold instead.
 */
const DROPPED_KEYS = new Set(['body', 'rawBody', 'requestBody', 'responseBody', 'operationOutcome', 'visitId'].map(normalizeKey));

/**
 * A copy of `value` fit for a log line: bodies and `visitId` dropped,
 * personal data under the key list replaced by `REDACTED`, and every string
 * scrubbed. An `Error` becomes its type (class name), message, stack and cause only, so
 * properties such as an attempt's facts are never logged.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) {
    // `type`, not `name`: `name` is on the key list.
    const { name: type, message, stack, cause } = value;
    return redact({ type, message, stack, ...(cause === undefined ? {} : { cause }) });
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !DROPPED_KEYS.has(normalizeKey(key)))
        .map(([key, v]) => [key, REDACTED_KEYS.has(normalizeKey(key)) ? REDACTED : redact(v)]),
    );
  }
  return value;
}
