// The mock's own MedicationRequest validator (ADR 0006): written separately
// from the hub's Validation module and sharing no code with it, so a wrong
// rule on one side shows up as a disagreement instead of passing on both.
import type { RejectionCode, Violation } from '../templates/operation-outcome.js';
import type { WorldKfaIngredient, WorldKfaProduct } from '../world/world.js';

/** `YYYY-MM-DDThh:mm:ss+00:00`, the only time format the rule dictionary allows. */
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;
/** No submitted date may be earlier than 03 June 2014. */
const DATE_FLOOR_MS = Date.parse('2014-06-03T00:00:00+00:00');
const PRESCRIPTION_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription\/(\d+)$/;
const PRESCRIPTION_ITEM_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription-item\/(\d+)$/;
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';

type Json = Record<string, unknown>;

/** What the validator judges a MedicationRequest against. */
export interface MedicationRequestContext {
  /** The submitting client's organization (one client maps to one organization). */
  organizationId: string;
  /** The mock's own KFA catalogue. */
  kfaProducts: readonly WorldKfaProduct[];
  kfaIngredients: readonly WorldKfaIngredient[];
  /** Whether the mock holds an Encounter with this id. */
  encounterExists(id: string): boolean;
}

/**
 * Checks a submitted MedicationRequest: the mandatory fields (the union of the
 * guide, the resource page and the rule dictionary: identifier, status,
 * intent, category, medication, subject, encounter, authoredOn, requester,
 * dispenseRequest.performer), a `+00:00` authoredOn on or after the floor,
 * exactly one `prescription/{org}` and one `prescription-item/{org}`
 * identifier of the client's organization, a KFA 92 or 93 product from its
 * own catalogue, a positive quantity counted in that product's dose form, and
 * an Encounter the mock holds (`REFERENCE_NOT_FOUND`). Returns every
 * violation; empty means valid.
 */
export function validateMedicationRequest(body: unknown, context: MedicationRequestContext): Violation[] {
  if (!isObject(body)) return [violation('PAYLOAD_INVALID', 'MedicationRequest', `expected a JSON object, got ${describe(body)}`)];
  const violations: Violation[] = [];
  const fail = (path: string, message: string, code: RejectionCode = 'PAYLOAD_INVALID'): void =>
    void violations.push(violation(code, `MedicationRequest.${path}`, message));

  if (body.resourceType !== 'MedicationRequest') fail('resourceType', `expected "MedicationRequest", got ${describe(body.resourceType)}`);
  checkIdentifiers(body.identifier, context.organizationId, fail);
  if (!nonEmptyString(body.status)) fail('status', 'is required');
  if (!nonEmptyString(body.intent)) fail('intent', 'is required');
  if (!Array.isArray(body.category) || body.category.length === 0) fail('category', 'needs at least one category');
  if (!isReferenceTo(body.subject, 'Patient')) fail('subject', `must reference "Patient/{ihs}", got ${describe(body.subject)}`);
  if (!isReferenceTo(body.requester, 'Practitioner')) fail('requester', `must reference "Practitioner/{ihs}", got ${describe(body.requester)}`);

  if (!isReferenceTo(body.encounter, 'Encounter')) {
    fail('encounter', `must reference "Encounter/{id}", got ${describe(body.encounter)}`);
  } else {
    const encounterId = body.encounter.reference.slice('Encounter/'.length);
    if (!context.encounterExists(encounterId)) fail('encounter', `references Encounter "${encounterId}", which the platform does not hold`, 'REFERENCE_NOT_FOUND');
  }

  checkAuthoredOn(body.authoredOn, fail);
  const doseFormCode = checkMedication(body, context, fail);
  checkDispenseRequest(body.dispenseRequest, context.organizationId, doseFormCode, fail);
  return violations;
}

type Fail = (path: string, message: string, code?: RejectionCode) => void;

function checkIdentifiers(identifier: unknown, organizationId: string, fail: Fail): void {
  const identifiers = Array.isArray(identifier) ? identifier.filter(isObject) : [];
  for (const [system, name] of [
    [PRESCRIPTION_SYSTEM, 'prescription'],
    [PRESCRIPTION_ITEM_SYSTEM, 'prescription-item'],
  ] as const) {
    const matching = identifiers.filter((i) => typeof i.system === 'string' && system.test(i.system));
    const [only] = matching;
    if (matching.length !== 1 || !only) {
      fail('identifier', `needs exactly one identifier under http://sys-ids.kemkes.go.id/${name}/{org}, got ${matching.length}`);
      continue;
    }
    const org = system.exec(String(only.system))?.[1];
    if (org !== organizationId) fail('identifier', `system "${String(only.system)}" must be ${name}/${organizationId}, the client's organization`);
    if (!nonEmptyString(only.value)) fail('identifier', `the ${name}/{org} identifier needs a non-empty value`);
  }
}

function checkAuthoredOn(value: unknown, fail: Fail): void {
  const match = typeof value === 'string' ? UTC_TIME.exec(value) : null;
  if (typeof value !== 'string' || !match) return fail('authoredOn', `must be YYYY-MM-DDThh:mm:ss+00:00, got ${describe(value)}`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return fail('authoredOn', `is not a real date and time, got "${value}"`);
  }
  if (ms < DATE_FLOOR_MS) fail('authoredOn', `must not be earlier than 2014-06-03T00:00:00+00:00, got "${value}"`);
}

/** Checks the contained Medication's KFA code against the catalogue; returns the product's dose form code when it is a 92 or 93. */
function checkMedication(body: Json, context: MedicationRequestContext, fail: Fail): string | undefined {
  const reference = isObject(body.medicationReference) ? body.medicationReference.reference : undefined;
  const contained = Array.isArray(body.contained) ? body.contained.filter(isObject) : [];
  const medication =
    typeof reference === 'string' && reference.startsWith('#')
      ? contained.find((c) => c.resourceType === 'Medication' && c.id === reference.slice(1))
      : undefined;
  if (!medication) return void fail('medication', `must reference a contained Medication ("#{id}"), got ${describe(body.medicationReference)}`);
  const codings = isObject(medication.code) && Array.isArray(medication.code.coding) ? medication.code.coding.filter(isObject) : [];
  const kfa = codings.find((c) => c.system === KFA_SYSTEM && nonEmptyString(c.code));
  if (!kfa) return void fail('medication', `the contained Medication needs a coding under ${KFA_SYSTEM}`);
  const code = String(kfa.code);
  const product = context.kfaProducts.find((p) => p.code === code);
  if (product) return product.doseForm.code;
  if (context.kfaIngredients.some((i) => i.code === code)) {
    return void fail('medication', `KFA ${code} is an ingredient (91); a prescription needs a 92 or 93`, 'KFA_LEVEL_INVALID');
  }
  return void fail('medication', `KFA ${code} is not in the catalogue`);
}

function checkDispenseRequest(dispenseRequest: unknown, organizationId: string, doseFormCode: string | undefined, fail: Fail): void {
  const request = isObject(dispenseRequest) ? dispenseRequest : {};
  const performer = isReferenceTo(request.performer, 'Organization') ? request.performer.reference : undefined;
  if (performer === undefined) {
    fail('dispenseRequest.performer', `must reference "Organization/{org}", got ${describe(request.performer)}`);
  } else if (performer !== `Organization/${organizationId}`) {
    fail('dispenseRequest.performer', `must be the client's organization "Organization/${organizationId}", got "${performer}"`);
  }
  if (request.quantity === undefined) return;
  const quantity = isObject(request.quantity) ? request.quantity : {};
  if (typeof quantity.value !== 'number' || !(quantity.value > 0)) {
    fail('dispenseRequest.quantity', `needs a positive value, got ${describe(quantity.value)}`);
  } else if (doseFormCode !== undefined && quantity.code !== doseFormCode) {
    fail('dispenseRequest.quantity', `must be counted in the product's dose form "${doseFormCode}", got ${describe(quantity.code)}`);
  }
}

function violation(code: RejectionCode, path: string, message: string): Violation {
  return { code, path, message: `${path} ${message}` };
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isReferenceTo(value: unknown, type: string): value is { reference: string } {
  if (!isObject(value) || typeof value.reference !== 'string') return false;
  return value.reference.startsWith(`${type}/`) && value.reference.length > type.length + 1;
}

function describe(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
