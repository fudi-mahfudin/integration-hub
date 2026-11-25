import { createHash } from 'node:crypto';

/**
 * RFC 8785 (JCS) canonical form of a value produced by `JSON.parse`: object
 * members sorted by UTF-16 code units, no whitespace, numbers and strings in
 * ECMAScript `JSON.stringify` form (which is what JCS specifies).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Hex SHA-256 of the canonical body (#7), so key order and whitespace do not
 * matter. A body that is not JSON is fingerprinted as its raw text (which can
 * never equal a canonical form, since that is always valid JSON).
 */
export function fingerprint(rawBody: string, parsed: { ok: true; value: unknown } | { ok: false }): string {
  const material = parsed.ok ? canonicalize(parsed.value) : rawBody;
  return createHash('sha256').update(material).digest('hex');
}
