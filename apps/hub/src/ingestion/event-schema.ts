import { z } from 'zod';
import type { AcceptedEvent } from '../cases/record-event.js';
import { EVENT_TYPES, type EventType, type PrescriptionId, type PrescriptionItemId, type VisitId } from '../cases/case-model.js';
import { Problem, type FieldError } from '../http/problem.js';
import type { RequestBody } from './fingerprint.js';
import { DATE_FLOOR, DATE_FLOOR_DAY, isCalendarDate, parseSourceTime } from './source-time.js';

/** The per-field codes of `VALIDATION_FAILED` this schema reports (#9). */
type FieldCode = 'REQUIRED' | 'INVALID_FORMAT' | 'TIME_OFFSET_MISSING' | 'DATE_BEFORE_FLOOR' | 'BATCH_INCOMPLETE' | 'INVALID_SUBSTITUTION_REASON';

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

const ENCOUNTER_CLASSES = ['AMB', 'IMP', 'EMER'] as const;

const visitStartedData = z.object({
  patient,
  practitioner,
  encounterClass: z.enum(ENCOUNTER_CLASSES, 'must be one of AMB, IMP, EMER'),
  locationCode: text(64),
  startedAt: sourceTime({ floor: true }),
});

const positive = z.number('must be a number').positive('must be greater than 0');

/** One drug item of a prescription (#6). */
const prescriptionItem = z.object({
  // Checked by text(64): this is where the source's item number becomes a PrescriptionItemId.
  itemId: text(64).transform((id) => id as PrescriptionItemId),
  drugCode: text(64),
  quantity: positive,
  dosage: z.object({
    text: text(500),
    timesPerDay: z.number('must be a number').int('must be a whole number').positive('must be greater than 0'),
    doseAmount: positive,
    routeCode: text(16),
  }),
});

/** `items` takes any length here; a count other than one is judged after the schema (`UNSUPPORTED_MULTI_ITEM`). */
const prescriptionWrittenData = z.object({
  // Checked by text(64): this is where the source's prescription number becomes a PrescriptionId.
  prescriptionId: text(64).transform((id) => id as PrescriptionId),
  authoredAt: sourceTime({ floor: true }),
  requester: practitioner,
  items: z.array(prescriptionItem, 'must be an array'),
});

/** Why a dispense is a substitution, as the source declares it (#9). */
const SUBSTITUTION_REASONS = ['OS', 'FP', 'DRUG_INTERACTION', 'PATIENT_CHOICE', 'PRESCRIPTION_ERROR'] as const;

/** A declared substitution's reason code. */
export type SubstitutionReason = (typeof SUBSTITUTION_REASONS)[number];

const isSubstitutionReason = (value: unknown): value is SubstitutionReason => (SUBSTITUTION_REASONS as readonly unknown[]).includes(value);

/** `substitution.reasonCode`: missing is REQUIRED; anything other than a known code is INVALID_SUBSTITUTION_REASON. */
const substitutionReason = z.unknown().transform((value, ctx): SubstitutionReason => {
  if (isSubstitutionReason(value)) return value;
  ctx.addIssue(
    value === undefined
      ? issue('REQUIRED', 'is required')
      : issue('INVALID_SUBSTITUTION_REASON', `must be one of ${SUBSTITUTION_REASONS.join(', ')}`),
  );
  return z.NEVER;
});

/** `batch.expiry`: a plain calendar date, never converted, not before the floor's date (#9). */
const expiryDate = z.string().superRefine((value, ctx) => {
  if (!isCalendarDate(value)) ctx.addIssue(issue('INVALID_FORMAT', 'must be a calendar date written YYYY-MM-DD'));
  // Both are YYYY-MM-DD, so they compare as strings.
  else if (value < DATE_FLOOR_DAY) ctx.addIssue(issue('DATE_BEFORE_FLOOR', `must not be before ${DATE_FLOOR_DAY}`));
});

/** `batch { lot, expiry }`: both or neither (#6). */
const batch = z
  .object({ lot: text(64).optional(), expiry: expiryDate.optional() })
  .superRefine(
    (b, ctx) => {
      if (has(b.lot) !== has(b.expiry)) ctx.addIssue(issue('BATCH_INCOMPLETE', 'needs both lot and expiry, or neither'));
    },
    { when: () => true },
  );

/** A dispense of the case's one prescription item (#6, #9). */
const drugDispensedData = z.object({
  // Checked by text(64), as for prescription.written.
  prescriptionId: text(64).transform((id) => id as PrescriptionId),
  itemId: text(64).transform((id) => id as PrescriptionItemId),
  drugCode: text(64),
  quantity: positive,
  preparedAt: sourceTime({ floor: true }),
  handedOverAt: sourceTime({ floor: true }),
  pharmacist: practitioner,
  batch: batch.optional(),
  substitution: z.object({ reasonCode: substitutionReason }).optional(),
});

/** The event types ingest accepts so far, each with its `data` schema. */
const DATA_SCHEMAS = {
  'visit.started': visitStartedData,
  'prescription.written': prescriptionWrittenData,
  'drug.dispensed': drugDispensedData,
} as const;

const ACCEPTED_TYPES = Object.keys(DATA_SCHEMAS) as (keyof typeof DATA_SCHEMAS)[]; // the keys of the object just above
const eventType = z.enum(ACCEPTED_TYPES, `must be one of ${ACCEPTED_TYPES.join(', ')}`);

/** The envelope `{ type, visitId, occurredAt, data }` (#6); `data` is checked against its type's schema separately. */
const envelope = z.object({
  type: eventType,
  visitId: text(64),
  occurredAt: sourceTime({ floor: false }),
  data: z.looseObject({}),
});

const visitStartedEnvelope = envelope.extend({ type: z.literal('visit.started'), data: visitStartedData });
const prescriptionWrittenEnvelope = envelope.extend({ type: z.literal('prescription.written'), data: prescriptionWrittenData });
const drugDispensedEnvelope = envelope.extend({ type: z.literal('drug.dispensed'), data: drugDispensedData });

/**
 * Checks a request body against the source event schema and returns the event
 * to record. Reports every violation at once: the envelope's and, when its
 * `type` is known, its `data`'s.
 * @throws Problem `VALIDATION_FAILED` (422) with one `errors[]` entry per violation.
 * @throws Problem `UNSUPPORTED_MULTI_ITEM` (422) when a valid prescription does not have exactly one item (ADR 0004).
 */
export function parseEvent(body: RequestBody): AcceptedEvent {
  if (!body.json) {
    throw new Problem('VALIDATION_FAILED', [{ path: '', code: 'INVALID_FORMAT', message: 'the body must be JSON' }]);
  }
  const parsedEnvelope = envelope.safeParse(body.value);
  const issues = parsedEnvelope.success ? [] : [...parsedEnvelope.error.issues];
  const type = eventType.safeParse(valueAt(body.value, ['type']));
  const data = valueAt(body.value, ['data']);
  if (type.success && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const parsedData = DATA_SCHEMAS[type.data].safeParse(data);
    if (!parsedData.success) issues.push(...parsedData.error.issues.map((i) => ({ ...i, path: ['data', ...i.path] })));
  }
  if (!parsedEnvelope.success || issues.length > 0 || !type.success) {
    throw new Problem(
      'VALIDATION_FAILED',
      issues.map((i) => fieldError(i, body.value)),
    );
  }

  const occurredAt = parseSourceTime(parsedEnvelope.data.occurredAt);
  if (!occurredAt.ok) throw new Error(`occurredAt passed the schema but does not parse: ${occurredAt.reason}`);
  const accepted = {
    // The schema checked it: a non-empty visit number of at most 64 characters.
    visitId: parsedEnvelope.data.visitId as VisitId,
    occurredAt: occurredAt.instant,
    envelope: body.value,
  };
  if (type.data === 'visit.started') return { ...accepted, type: 'visit.started', prescriptionItem: null };
  if (type.data === 'drug.dispensed') {
    const { prescriptionId, itemId } = drugDispensedData.parse(data);
    return { ...accepted, type: 'drug.dispensed', prescriptionItem: { prescriptionId, itemId } };
  }

  const { prescriptionId, items } = prescriptionWrittenData.parse(data);
  const [item] = items;
  if (items.length !== 1 || !item) {
    throw new Problem('UNSUPPORTED_MULTI_ITEM', [
      { path: '/data/items', code: 'UNSUPPORTED_MULTI_ITEM', message: `must hold exactly one drug item, got ${items.length}` },
    ]);
  }
  return { ...accepted, type: 'prescription.written', prescriptionItem: { prescriptionId, itemId: item.itemId } };
}

/**
 * The visit and event type a rejected body names, when both are readable as
 * the envelope defines them; the rejection log is keyed by them (#8).
 */
export function rejectedEventOf(body: RequestBody): { visitId: VisitId; eventType: EventType } | undefined {
  if (!body.json) return undefined;
  const visitId = text(64).safeParse(valueAt(body.value, ['visitId']));
  const type = z.enum(EVENT_TYPES).safeParse(valueAt(body.value, ['type']));
  // Checked just above against the envelope's own visitId rule.
  return visitId.success && type.success ? { visitId: visitId.data as VisitId, eventType: type.data } : undefined;
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

/** The fields of a recorded `visit.started` that the create visit step sends. */
export interface VisitStartedFacts {
  patient: { nik?: string | undefined };
  practitioner: { nik?: string | undefined };
  encounterClass: (typeof ENCOUNTER_CLASSES)[number];
  locationCode: string;
  startedAt: Date;
}

/**
 * Reads a recorded `visit.started` envelope back from storage. It passed this
 * schema at ingest, so a failure here means the stored row was changed.
 */
export function readVisitStarted(storedEnvelope: unknown): VisitStartedFacts {
  const parsed = visitStartedEnvelope.safeParse(storedEnvelope);
  if (!parsed.success) {
    throw new Error(`a stored visit.started no longer matches its schema: ${parsed.error.issues.map((i) => pointer(i.path)).join(', ')}`);
  }
  const { patient, practitioner, encounterClass, locationCode, startedAt } = parsed.data.data;
  const started = parseSourceTime(startedAt);
  if (!started.ok) throw new Error(`a stored startedAt passed the schema but does not parse: ${started.reason}`);
  return { patient, practitioner, encounterClass, locationCode, startedAt: started.instant };
}

/** The fields of a recorded `prescription.written` that the submit prescription step sends. */
export interface PrescriptionWrittenFacts {
  prescriptionId: PrescriptionId;
  authoredAt: Date;
  requester: { nik?: string | undefined };
  item: z.infer<typeof prescriptionItem>;
}

/**
 * Reads a recorded `prescription.written` envelope back from storage. It
 * passed this schema and the one-item rule at ingest, so a failure here means
 * the stored row was changed.
 */
export function readPrescriptionWritten(storedEnvelope: unknown): PrescriptionWrittenFacts {
  const parsed = prescriptionWrittenEnvelope.safeParse(storedEnvelope);
  if (!parsed.success) {
    throw new Error(`a stored prescription.written no longer matches its schema: ${parsed.error.issues.map((i) => pointer(i.path)).join(', ')}`);
  }
  const { prescriptionId, authoredAt, requester, items } = parsed.data.data;
  const [item] = items;
  if (items.length !== 1 || !item) throw new Error(`a stored prescription.written has ${items.length} items, not the one ingest accepted`);
  const authored = parseSourceTime(authoredAt);
  if (!authored.ok) throw new Error(`a stored authoredAt passed the schema but does not parse: ${authored.reason}`);
  return { prescriptionId, authoredAt: authored.instant, requester, item };
}

/** The fields of a recorded `drug.dispensed` that the submit dispense step sends. */
export interface DrugDispensedFacts {
  prescriptionId: PrescriptionId;
  itemId: PrescriptionItemId;
  drugCode: string;
  quantity: number;
  preparedAt: Date;
  handedOverAt: Date;
  pharmacist: { nik?: string | undefined };
  /** The batch handed over; null when the source sent none. `expiry` stays a plain date. */
  batch: { lot: string; expiry: string } | null;
  /** The source's substitution declaration; null when it declared none. */
  substitution: { reasonCode: SubstitutionReason } | null;
}

/**
 * Reads a recorded `drug.dispensed` envelope back from storage. It passed this
 * schema at ingest, so a failure here means the stored row was changed.
 */
export function readDrugDispensed(storedEnvelope: unknown): DrugDispensedFacts {
  const parsed = drugDispensedEnvelope.safeParse(storedEnvelope);
  if (!parsed.success) {
    throw new Error(`a stored drug.dispensed no longer matches its schema: ${parsed.error.issues.map((i) => pointer(i.path)).join(', ')}`);
  }
  const { prescriptionId, itemId, drugCode, quantity, preparedAt, handedOverAt, pharmacist, batch, substitution } = parsed.data.data;
  const prepared = parseSourceTime(preparedAt);
  const handedOver = parseSourceTime(handedOverAt);
  if (!prepared.ok || !handedOver.ok) throw new Error('a stored preparedAt or handedOverAt passed the schema but does not parse');
  const { lot, expiry } = batch ?? {};
  return {
    prescriptionId,
    itemId,
    drugCode,
    quantity,
    preparedAt: prepared.instant,
    handedOverAt: handedOver.instant,
    pharmacist,
    // The schema takes lot and expiry both or neither.
    batch: lot !== undefined && expiry !== undefined ? { lot, expiry } : null,
    substitution: substitution ?? null,
  };
}
