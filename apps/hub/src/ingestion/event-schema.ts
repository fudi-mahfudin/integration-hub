import { z } from 'zod';
import type { AcceptedEvent } from '../cases/record-event.js';
import type { VisitId } from '../cases/case-model.js';
import { Problem, type FieldError } from '../http/problem.js';
import type { RequestBody } from './fingerprint.js';
import { DATE_FLOOR, isCalendarDate, parseSourceTime } from './source-time.js';

/** The per-field codes of `VALIDATION_FAILED` this schema reports (#9). */
type FieldCode = 'REQUIRED' | 'INVALID_FORMAT' | 'TIME_OFFSET_MISSING' | 'DATE_BEFORE_FLOOR';

const NIK = /^\d{16}$/;

/** Builds a custom issue carrying one of our field codes in `params.code`. */
function issue(code: FieldCode, message: string): z.core.$ZodRawIssue {
  return { code: 'custom', params: { code }, message, path: [], input: undefined };
}

const text = (max: number) => z.string().min(1, 'must not be empty').max(max, `must be at most ${max} characters`);

/** A source time: explicit offset required; optionally not before the date floor. */
const sourceTime = (opts: { floor: boolean }) =>
  z.string().superRefine((value, ctx) => {
    const parsed = parseSourceTime(value);
    if (!parsed.ok) {
      ctx.addIssue(
        parsed.reason === 'offset_missing'
          ? issue('TIME_OFFSET_MISSING', 'must carry an explicit offset, e.g. 2026-03-02T08:00:00+07:00')
          : issue('INVALID_FORMAT', 'must be an ISO 8601 date-time with an offset, e.g. 2026-03-02T08:00:00+07:00'),
      );
    } else if (opts.floor && parsed.instant < DATE_FLOOR) {
      ctx.addIssue(issue('DATE_BEFORE_FLOOR', 'must not be before 2014-06-03T00:00:00+00:00 (compared in UTC)'));
    }
  });

const nik = z.string().regex(NIK, 'must be 16 digits');
const birthDate = z.string().refine(isCalendarDate, 'must be a calendar date written YYYY-MM-DD');
const gender = z.enum(['male', 'female'], 'must be "male" or "female"');

/** Present fields only; their own formats are checked (and reported) separately. */
const has = (value: unknown) => value !== undefined && value !== null;

/** `patient`: one of `nik` | `motherNik` + `birthDate` | `name` + `birthDate` + `gender`, plus `mrn` (#6). */
const patient = z
  .object({
    nik: nik.optional(),
    motherNik: nik.optional(),
    name: text(200).optional(),
    birthDate: birthDate.optional(),
    gender: gender.optional(),
    mrn: text(64),
  })
  .superRefine(
    (p, ctx) => {
      const identified =
        has(p.nik) || (has(p.motherNik) && has(p.birthDate)) || (has(p.name) && has(p.birthDate) && has(p.gender));
      if (!identified) {
        ctx.addIssue(issue('REQUIRED', 'needs nik, or motherNik + birthDate, or name + birthDate + gender'));
      }
    },
    // Run even when a field is malformed, so every violation is reported at once.
    { when: () => true },
  );

/** A practitioner: `{ nik }` or `{ name, birthDate, gender }` (#6). */
const practitioner = z
  .object({ nik: nik.optional(), name: text(200).optional(), birthDate: birthDate.optional(), gender: gender.optional() })
  .superRefine(
    (p, ctx) => {
      if (!has(p.nik) && !(has(p.name) && has(p.birthDate) && has(p.gender))) {
        ctx.addIssue(issue('REQUIRED', 'needs nik, or name + birthDate + gender'));
      }
    },
    { when: () => true },
  );

const visitStartedData = z.object({
  patient,
  practitioner,
  encounterClass: z.enum(['AMB', 'IMP', 'EMER'], 'must be one of AMB, IMP, EMER'),
  locationCode: text(64),
  startedAt: sourceTime({ floor: true }),
});

/** The envelope `{ type, visitId, occurredAt, data }` (#6); `visit.started` is the only type so far. */
const envelope = z.object({
  type: z.literal('visit.started', 'must be "visit.started"'),
  visitId: text(64),
  occurredAt: sourceTime({ floor: false }),
  data: visitStartedData,
});

/**
 * Checks a request body against the source event schema and returns the event
 * to record. Reports every violation at once.
 * @throws Problem `VALIDATION_FAILED` (422) with one `errors[]` entry per violation.
 */
export function parseEvent(body: RequestBody): AcceptedEvent {
  if (!body.json) {
    throw new Problem('VALIDATION_FAILED', [{ path: '', code: 'INVALID_FORMAT', message: 'the body must be JSON' }]);
  }
  const parsed = envelope.safeParse(body.value);
  if (!parsed.success) {
    throw new Problem(
      'VALIDATION_FAILED',
      parsed.error.issues.map((i) => fieldError(i, body.value)),
    );
  }
  const occurredAt = parseSourceTime(parsed.data.occurredAt);
  if (!occurredAt.ok) throw new Error(`occurredAt passed the schema but does not parse: ${occurredAt.reason}`);
  return {
    type: parsed.data.type,
    // The schema checked it: a non-empty visit number of at most 64 characters.
    visitId: parsed.data.visitId as VisitId,
    occurredAt: occurredAt.instant,
    envelope: body.value,
  };
}

function fieldError(i: z.core.$ZodIssue, input: unknown): FieldError {
  const path = pointer(i.path);
  if (i.code === 'custom') {
    const code: unknown = i.params?.code;
    return { path, code: typeof code === 'string' ? code : 'INVALID_FORMAT', message: i.message };
  }
  if (valueAt(input, i.path) === undefined) {
    return { path, code: 'REQUIRED', message: 'is required' };
  }
  return { path, code: 'INVALID_FORMAT', message: i.message };
}

/** RFC 6901 JSON Pointer of a zod path. */
function pointer(path: readonly PropertyKey[]): string {
  return path.map((p) => `/${String(p).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}
