import type { z } from 'zod';
import { Problem, type FieldError } from './problem.js';

/**
 * Parses an operator request's raw body (the composition root makes every
 * body arrive as text) against `schema`; an empty body is `{}`.
 * @throws Problem `VALIDATION_FAILED` (422) naming each bad field by JSON Pointer.
 */
export function parseRequestBody<T>(rawBody: unknown, schema: z.ZodType<T>): T {
  const text = typeof rawBody === 'string' ? rawBody : '';
  let value: unknown;
  try {
    value = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new Problem('VALIDATION_FAILED', [{ path: '', code: 'INVALID_FORMAT', message: 'the body must be JSON' }]);
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Problem(
    'VALIDATION_FAILED',
    parsed.error.issues.map((i): FieldError => {
      const path = i.path.map((p) => `/${String(p).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
      return i.code === 'invalid_type' && i.input === undefined
        ? { path, code: 'REQUIRED', message: 'is required' }
        : { path, code: 'INVALID_FORMAT', message: i.message };
    }),
  );
}
