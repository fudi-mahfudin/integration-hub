import type { EventType } from '../cases/case-model.js';
import { Problem, type FieldError } from '../http/problem.js';
import { isRealDate, parseSourceTime } from '../time.js';

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

/** SATUSEHAT's date floor, compared on the UTC instant (#9). */
export const DATE_FLOOR = new Date('2014-06-03T00:00:00+00:00');

/** Event types ingest accepts so far; the other three arrive with #29-#31. */
const SUPPORTED_TYPES: readonly EventType[] = ['visit.started'];
const ENCOUNTER_CLASSES = ['AMB', 'IMP', 'EMER'];
const GENDERS = ['male', 'female'];
const MAX_VISIT_ID_LENGTH = 255;

/**
 * Validates a source event's own schema (#6, #9), reporting every violation
 * at once. Never reads mappings or other events (those are cross-event
 * checks, run after this passes).
 * @throws Problem 422 `VALIDATION_FAILED` with every violation in `errors[]`.
 */
export function validateEvent(body: ParsedBody): ValidatedEvent {
  const c = new Checker();
  if (!body.ok || !isObject(body.value)) {
    c.add('', 'INVALID_FORMAT', 'body must be a JSON object');
    return c.throwIfAny() as never;
  }
  const envelope = body.value;

  const type = envelope.type;
  if (c.required('/type', type)) {
    if (typeof type !== 'string' || !SUPPORTED_TYPES.includes(type as EventType)) {
      c.add('/type', 'INVALID_FORMAT', `must be one of ${SUPPORTED_TYPES.join(', ')}`);
    }
  }
  c.string('/visitId', envelope.visitId, { maxLength: MAX_VISIT_ID_LENGTH });
  const occurredAt = c.time('/occurredAt', envelope.occurredAt, { floor: false });
  const data = envelope.data;
  if (c.required('/data', data)) {
    if (!isObject(data)) c.add('/data', 'INVALID_FORMAT', 'must be an object');
    else if (type === 'visit.started') checkVisitStarted(c, data);
  }

  c.throwIfAny();
  return { type: type as EventType, visitId: envelope.visitId as string, occurredAt: occurredAt as Date, envelope };
}

function checkVisitStarted(c: Checker, data: Record<string, unknown>): void {
  if (c.required('/data/patient', data.patient)) checkPatient(c, data.patient);
  if (c.required('/data/practitioner', data.practitioner)) checkPractitioner(c, '/data/practitioner', data.practitioner);
  c.oneOf('/data/encounterClass', data.encounterClass, ENCOUNTER_CLASSES);
  c.string('/data/locationCode', data.locationCode);
  c.time('/data/startedAt', data.startedAt, { floor: true });
}

/** `{ nik?, mrn, name?, birthDate?, gender?, motherNik? }`, identified by one of three combinations (#6). */
function checkPatient(c: Checker, patient: unknown): void {
  const path = '/data/patient';
  if (!isObject(patient)) return c.add(path, 'INVALID_FORMAT', 'must be an object');
  c.string(`${path}/mrn`, patient.mrn);
  c.optional(`${path}/nik`, patient.nik, (p, v) => c.nik(p, v));
  c.optional(`${path}/motherNik`, patient.motherNik, (p, v) => c.nik(p, v));
  c.optional(`${path}/name`, patient.name, (p, v) => c.string(p, v));
  c.optional(`${path}/birthDate`, patient.birthDate, (p, v) => c.date(p, v));
  c.optional(`${path}/gender`, patient.gender, (p, v) => c.oneOf(p, v, GENDERS));
  const has = (k: string) => patient[k] !== undefined;
  const identified =
    has('nik') || (has('motherNik') && has('birthDate')) || (has('name') && has('birthDate') && has('gender'));
  if (!identified) c.add(path, 'REQUIRED', 'needs nik, or motherNik + birthDate, or name + birthDate + gender');
}

/** `{ nik }` or `{ name, birthDate, gender }` (#6). */
function checkPractitioner(c: Checker, path: string, person: unknown): void {
  if (!isObject(person)) return c.add(path, 'INVALID_FORMAT', 'must be an object');
  c.optional(`${path}/nik`, person.nik, (p, v) => c.nik(p, v));
  c.optional(`${path}/name`, person.name, (p, v) => c.string(p, v));
  c.optional(`${path}/birthDate`, person.birthDate, (p, v) => c.date(p, v));
  c.optional(`${path}/gender`, person.gender, (p, v) => c.oneOf(p, v, GENDERS));
  const has = (k: string) => person[k] !== undefined;
  if (!(has('nik') || (has('name') && has('birthDate') && has('gender')))) {
    c.add(path, 'REQUIRED', 'needs nik, or name + birthDate + gender');
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Collects violations in check order; paths are JSON Pointers (RFC 6901). */
class Checker {
  private readonly errors: FieldError[] = [];

  add(path: string, code: string, message: string): void {
    this.errors.push({ path, code, message });
  }

  throwIfAny(): void {
    if (this.errors.length > 0) throw new Problem(422, 'VALIDATION_FAILED', this.errors);
  }

  /** Records `REQUIRED` when absent; true when present. `null` counts as absent. */
  required(path: string, value: unknown): boolean {
    if (value === undefined || value === null) {
      this.add(path, 'REQUIRED', 'is required');
      return false;
    }
    return true;
  }

  optional(path: string, value: unknown, check: (path: string, value: unknown) => void): void {
    if (value !== undefined) check(path, value);
  }

  string(path: string, value: unknown, { maxLength = Infinity } = {}): void {
    if (!this.required(path, value)) return;
    if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
      const limit = maxLength === Infinity ? '' : ` of at most ${maxLength} characters`;
      this.add(path, 'INVALID_FORMAT', `must be a non-empty string${limit}`);
    }
  }

  oneOf(path: string, value: unknown, allowed: readonly string[]): void {
    if (!this.required(path, value)) return;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.add(path, 'INVALID_FORMAT', `must be one of ${allowed.join(', ')}`);
    }
  }

  nik(path: string, value: unknown): void {
    if (typeof value !== 'string' || !/^\d{16}$/.test(value)) this.add(path, 'INVALID_FORMAT', 'must be 16 digits');
  }

  date(path: string, value: unknown): void {
    const m = typeof value === 'string' ? DATE.exec(value) : null;
    if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
      this.add(path, 'INVALID_FORMAT', 'must be a calendar date YYYY-MM-DD');
    }
  }

  /** An instant with an explicit offset; with `floor`, not before `DATE_FLOOR` in UTC (#9). */
  time(path: string, value: unknown, { floor }: { floor: boolean }): Date | undefined {
    if (!this.required(path, value)) return undefined;
    const parsed = parseSourceTime(typeof value === 'string' ? value : '');
    if (!parsed.ok) {
      if (parsed.reason === 'offset_missing') {
        this.add(path, 'TIME_OFFSET_MISSING', 'must be a full date-time with an offset, e.g. +07:00');
      } else {
        this.add(path, 'INVALID_FORMAT', 'must be an ISO 8601 date-time with an offset');
      }
      return undefined;
    }
    const instant = parsed.instant;
    if (floor && instant < DATE_FLOOR) {
      this.add(path, 'DATE_BEFORE_FLOOR', 'must not be before 2014-06-03T00:00:00+00:00 (compared in UTC)');
      return undefined;
    }
    return instant;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
