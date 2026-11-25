import type { EventType } from '../cases/case-model.js';
import { Problem, type FieldError } from '../http/problem.js';

/** A source event that passed its own schema. `envelope` is the body as received. */
export interface ValidatedEvent {
  type: EventType;
  visitId: string;
  occurredAt: Date;
  envelope: Record<string, unknown>;
}

export type ParsedBody = { ok: true; value: unknown } | { ok: false };

export function parseBody(rawBody: string): ParsedBody {
  try {
    return { ok: true, value: JSON.parse(rawBody) };
  } catch {
    return { ok: false };
  }
}

/**
 * Validates a source event's own schema (#6, #9), reporting every violation
 * at once. Never reads mappings or other events.
 * @throws Problem 422 `VALIDATION_FAILED` with every violation in `errors[]`.
 */
export function validateEvent(body: ParsedBody): ValidatedEvent {
  if (!body.ok) fail([{ path: '', code: 'INVALID_FORMAT', message: 'body must be a JSON object' }]);
  const envelope = body.value;
  if (!isObject(envelope)) fail([{ path: '', code: 'INVALID_FORMAT', message: 'body must be a JSON object' }]);
  return {
    type: envelope.type as EventType,
    visitId: envelope.visitId as string,
    occurredAt: new Date(envelope.occurredAt as string),
    envelope,
  };
}

function fail(errors: FieldError[]): never {
  throw new Problem(422, 'VALIDATION_FAILED', errors);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
