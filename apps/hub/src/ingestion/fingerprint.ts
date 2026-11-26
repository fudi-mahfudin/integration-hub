import { createHash } from 'node:crypto';
import type { Brand } from '../brand.js';

/** Hex SHA-256 of a request body's canonical form (#7). */
export type Fingerprint = Brand<string, 'Fingerprint'>;

/** A request body: parsed JSON, or the raw text when it isn't JSON. */
export type RequestBody = { json: true; value: unknown } | { json: false; text: string };

/**
 * The body's fingerprint (#7): SHA-256 of its RFC 8785 (JCS) canonical form,
 * so key order and whitespace don't matter. A body that isn't JSON is hashed
 * as its raw text, which can never equal a canonical form (that is always
 * valid JSON).
 */
export function fingerprint(body: RequestBody): Fingerprint {
  const material = body.json ? canonicalize(body.value) : body.text;
  // A SHA-256 hex digest is what a fingerprint is.
  return createHash('sha256').update(material).digest('hex') as Fingerprint;
}

/**
 * RFC 8785 canonical form of a value produced by `JSON.parse`: object members
 * sorted by UTF-16 code units, no whitespace, and strings and numbers in
 * ECMAScript `JSON.stringify` form, which is what JCS specifies.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const members = Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${members.join(',')}}`;
}
