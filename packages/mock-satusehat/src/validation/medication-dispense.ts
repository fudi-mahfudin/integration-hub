// The mock's own MedicationDispense validator (ADR 0006): written separately
// from the hub's Validation module and sharing no code with it, so a wrong
// rule on one side shows up as a disagreement instead of passing on both.
import type { RejectionCode, Violation } from '../templates/operation-outcome.js';
import type { WorldKfaIngredient, WorldKfaProduct } from '../world/world.js';

/** `YYYY-MM-DDThh:mm:ss+00:00`, the only time format the rule dictionary allows. */
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+00:00$/;
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** No submitted date may be earlier than 03 June 2014. */
const DATE_FLOOR_MS = Date.parse('2014-06-03T00:00:00+00:00');
const PRESCRIPTION_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription\/(\d+)$/;
const PRESCRIPTION_ITEM_SYSTEM = /^http:\/\/sys-ids\.kemkes\.go\.id\/prescription-item\/(\d+)$/;
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';
const SUBSTITUTION_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution';

type Json = Record<string, unknown>;

/** What the validator judges a MedicationDispense against. */
export interface MedicationDispenseContext {
  /** The submitting client's organization (one client maps to one organization). */
  organizationId: string;
  /** The mock's own KFA catalogue. */
  kfaProducts: readonly WorldKfaProduct[];
  /** The ingredients (91) of its catalogue, so a dispensed ingredient is told apart from an unknown code. */
  kfaIngredients: readonly WorldKfaIngredient[];
  /** Whether the mock holds an Encounter with this id. */
  encounterExists(id: string): boolean;
  /** The KFA code a MedicationRequest the mock holds prescribes; undefined when it holds no such MedicationRequest. */
  prescribedKfaCode(medicationRequestId: string): string | undefined;
}

/**
 * Checks a submitted MedicationDispense: the mandatory fields (the union of
 * the guide, the resource page and the rule dictionary: identifier, status,
 * medication, subject, context, performer.actor, authorizingPrescription,
 * quantity, whenPrepared, whenHandedOver, substitution.wasSubstituted),
 * `+00:00` times on or after the floor, a batch (when sent) with a lot and a
 * plain expiry date on or after the floor, exactly one `prescription/{org}`
 * and one `prescription-item/{org}` identifier of the client's organization,
 * a positive quantity counted in the dispensed product's dose form, an
 * Encounter and an authorizing MedicationRequest the mock holds
 * (`REFERENCE_NOT_FOUND`), and the KFA rules: an actual product (93) from its
 * own catalogue (`KFA_LEVEL_INVALID`), whose relation to the prescribed
 * product agrees with `wasSubstituted` (`SUBSTITUTION_MISMATCH`) and is not a
 * therapeutic substitution (`UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`). A
 * substitution names its type, reason and both responsible practitioners
 * (the requester and the pharmacist).
 * Returns every violation; empty means valid.
 */
export function validateMedicationDispense(body: unknown, context: MedicationDispenseContext): Violation[] {
  if (!isObject(body)) return [violation('PAYLOAD_INVALID', 'MedicationDispense', `expected a JSON object, got ${describe(body)}`)];
  const violations: Violation[] = [];
  const fail = (path: string, message: string, code: RejectionCode = 'PAYLOAD_INVALID'): void =>
    void violations.push(violation(code, `MedicationDispense.${path}`, message));

  if (body.resourceType !== 'MedicationDispense') fail('resourceType', `expected "MedicationDispense", got ${describe(body.resourceType)}`);
  checkIdentifiers(body.identifier, context.organizationId, fail);
  if (!nonEmptyString(body.status)) fail('status', 'is required');
  if (!isReferenceTo(body.subject, 'Patient')) fail('subject', `must reference "Patient/{ihs}", got ${describe(body.subject)}`);
  const performers = Array.isArray(body.performer) ? body.performer.filter(isObject) : [];
  if (performers.length === 0 || !performers.every((p) => isReferenceTo(p.actor, 'Practitioner'))) {
    fail('performer', `needs at least one actor referencing "Practitioner/{ihs}", got ${describe(body.performer)}`);
  }

  if (!isReferenceTo(body.context, 'Encounter')) {
    fail('context', `must reference "Encounter/{id}", got ${describe(body.context)}`);
  } else {
    const encounterId = body.context.reference.slice('Encounter/'.length);
    if (!context.encounterExists(encounterId)) fail('context', `references Encounter "${encounterId}", which the platform does not hold`, 'REFERENCE_NOT_FOUND');
  }

  const prescriptions = Array.isArray(body.authorizingPrescription) ? body.authorizingPrescription : [];
  const [prescription] = prescriptions;
  let prescribedCode: string | undefined;
  if (prescriptions.length !== 1 || !isReferenceTo(prescription, 'MedicationRequest')) {
    fail('authorizingPrescription', `needs exactly one reference to "MedicationRequest/{id}", got ${describe(body.authorizingPrescription)}`);
  } else {
    const medicationRequestId = prescription.reference.slice('MedicationRequest/'.length);
    prescribedCode = context.prescribedKfaCode(medicationRequestId);
    if (prescribedCode === undefined) {
      fail('authorizingPrescription', `references MedicationRequest "${medicationRequestId}", which the platform does not hold`, 'REFERENCE_NOT_FOUND');
    }
  }
  const prescribed = context.kfaProducts.find((p) => p.code === prescribedCode);
  if (prescribedCode !== undefined && !prescribed) {
    // Never skip the substitution rules: a prescription the dispense can't be judged against is rejected.
    fail('authorizingPrescription', `prescribes KFA ${prescribedCode}, which is not a product in the catalogue, so the dispense can't be judged`);
  }

  checkTime(body.whenPrepared, 'whenPrepared', fail);
  checkTime(body.whenHandedOver, 'whenHandedOver', fail);
  const product = checkMedication(body, context, fail);
  checkQuantity(body.quantity, product?.doseForm.code, fail);

  const substitution = isObject(body.substitution) ? body.substitution : {};
  if (typeof substitution.wasSubstituted !== 'boolean') {
    fail('substitution.wasSubstituted', `is required as a boolean, got ${describe(substitution.wasSubstituted)}`);
  } else {
    if (product?.level === 93 && prescribed) checkSubstitution(prescribed, product, substitution.wasSubstituted, fail);
    if (substitution.wasSubstituted) checkSubstitutionDetails(substitution, fail);
  }
  return violations;
}

/**
 * The dispensed 93 against the prescribed product: the prescribed product
 * itself or a child of the prescribed 92 is no substitution; another product
 * with exactly the same 91 set is one; any other 91 set is a therapeutic
 * substitution, which is not supported.
 */
function checkSubstitution(prescribed: WorldKfaProduct, dispensed: Extract<WorldKfaProduct, { level: 93 }>, wasSubstituted: boolean, fail: Fail): void {
  const asPrescribed = dispensed.code === prescribed.code || (prescribed.level === 92 && dispensed.parent === prescribed.code);
  const prescribedSet = new Set(prescribed.ingredients);
  const dispensedSet = new Set(dispensed.ingredients);
  const sameIngredients = prescribedSet.size === dispensedSet.size && [...prescribedSet].every((c) => dispensedSet.has(c));
  if (!asPrescribed && !sameIngredients) {
    return fail(
      'medication',
      `KFA ${dispensed.code} has other active ingredients than the prescribed ${prescribed.code}; a therapeutic substitution is not supported`,
      'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
    );
  }
  if (wasSubstituted === asPrescribed) {
    fail(
      'substitution.wasSubstituted',
      `must be ${!asPrescribed}: dispensing ${dispensed.code} for the prescribed ${prescribed.code} is ${asPrescribed ? 'not ' : ''}a substitution`,
      'SUBSTITUTION_MISMATCH',
    );
  }
}

/** A substitution's type, reason and responsible practitioners. */
function checkSubstitutionDetails(substitution: Json, fail: Fail): void {
  const codings = (concept: unknown) => (isObject(concept) && Array.isArray(concept.coding) ? concept.coding.filter(isObject) : []);
  if (!codings(substitution.type).some((c) => c.system === SUBSTITUTION_TYPE_SYSTEM && nonEmptyString(c.code))) {
    fail('substitution.type', `needs a coding under ${SUBSTITUTION_TYPE_SYSTEM}, got ${describe(substitution.type)}`);
  }
  const reasons = Array.isArray(substitution.reason) ? substitution.reason : [];
  if (!reasons.some((r) => codings(r).some((c) => nonEmptyString(c.system) && nonEmptyString(c.code)))) {
    fail('substitution.reason', `needs at least one coded reason, got ${describe(substitution.reason)}`);
  }
  const parties = Array.isArray(substitution.responsibleParty) ? substitution.responsibleParty : [];
  if (parties.length < 2 || !parties.every((p) => isReferenceTo(p, 'Practitioner'))) {
    fail('substitution.responsibleParty', `needs the requester and the pharmacist ("Practitioner/{ihs}"), got ${describe(substitution.responsibleParty)}`);
  }
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

function checkTime(value: unknown, path: string, fail: Fail): void {
  const match = typeof value === 'string' ? UTC_TIME.exec(value) : null;
  if (typeof value !== 'string' || !match) return fail(path, `must be YYYY-MM-DDThh:mm:ss+00:00, got ${describe(value)}`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return fail(path, `is not a real date and time, got "${value}"`);
  }
  if (ms < DATE_FLOOR_MS) fail(path, `must not be earlier than 2014-06-03T00:00:00+00:00, got "${value}"`);
}

/** Checks the contained Medication: a KFA code in the catalogue and its batch; returns its catalogue product. */
function checkMedication(body: Json, context: MedicationDispenseContext, fail: Fail): WorldKfaProduct | undefined {
  const reference = isObject(body.medicationReference) ? body.medicationReference.reference : undefined;
  const contained = Array.isArray(body.contained) ? body.contained.filter(isObject) : [];
  const medication =
    typeof reference === 'string' && reference.startsWith('#')
      ? contained.find((c) => c.resourceType === 'Medication' && c.id === reference.slice(1))
      : undefined;
  if (!medication) return void fail('medication', `must reference a contained Medication ("#{id}"), got ${describe(body.medicationReference)}`);
  checkBatch(medication.batch, fail);
  const codings = isObject(medication.code) && Array.isArray(medication.code.coding) ? medication.code.coding.filter(isObject) : [];
  const kfa = codings.find((c) => c.system === KFA_SYSTEM && nonEmptyString(c.code));
  if (!kfa) return void fail('medication', `the contained Medication needs a coding under ${KFA_SYSTEM}`);
  const code = String(kfa.code);
  const product = context.kfaProducts.find((p) => p.code === code);
  if (product?.level === 92) fail('medication', `KFA ${code} is a virtual product (92); a dispense needs an actual product (93)`, 'KFA_LEVEL_INVALID');
  if (product) return product;
  if (context.kfaIngredients.some((i) => i.code === code)) {
    return void fail('medication', `KFA ${code} is an ingredient (91); a dispense needs a 93`, 'KFA_LEVEL_INVALID');
  }
  return void fail('medication', `KFA ${code} is not in the catalogue`);
}

function checkBatch(batch: unknown, fail: Fail): void {
  if (batch === undefined) return;
  const path = 'contained.Medication.batch';
  if (!isObject(batch)) return fail(path, `must be an object, got ${describe(batch)}`);
  if (!nonEmptyString(batch.lotNumber)) fail(`${path}.lotNumber`, `is required in a batch, got ${describe(batch.lotNumber)}`);
  const expiry = batch.expirationDate;
  const ms = typeof expiry === 'string' && PLAIN_DATE.test(expiry) ? Date.parse(`${expiry}T00:00:00+00:00`) : NaN;
  if (typeof expiry !== 'string' || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== expiry) {
    fail(`${path}.expirationDate`, `must be a real date YYYY-MM-DD, got ${describe(expiry)}`);
  } else if (ms < DATE_FLOOR_MS) {
    fail(`${path}.expirationDate`, `must not be earlier than 2014-06-03, got "${expiry}"`);
  }
}

function checkQuantity(value: unknown, doseFormCode: string | undefined, fail: Fail): void {
  const quantity = isObject(value) ? value : {};
  if (typeof quantity.value !== 'number' || !(quantity.value > 0)) {
    fail('quantity', `needs a positive value, got ${describe(quantity.value)}`);
  } else if (!nonEmptyString(quantity.unit)) {
    fail('quantity', `needs a unit, got ${describe(quantity.unit)}`);
  } else if (doseFormCode !== undefined && quantity.code !== doseFormCode) {
    fail('quantity', `must be counted in the product's dose form "${doseFormCode}", got ${describe(quantity.code)}`);
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
