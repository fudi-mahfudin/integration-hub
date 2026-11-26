// The hub's PAYLOAD_INVALID rules for a MedicationDispense (#9). Internal to
// the Validation module: callers go through `validateStepPayload`.
import type { OrganizationId } from '../auth/source-systems.js';
import {
  checkBusinessIdentifier,
  checkPlainDate,
  checkTime,
  containedMedication,
  describe,
  isObject,
  isReferenceTo,
  nonEmptyArray,
  nonEmptyString,
  type Fail,
} from './payload-checks.js';

// Written out here, not imported from the builder in satusehat/resources.ts:
// the check must not trust the code it checks.
const SYSTEM_PREFIX = 'http://sys-ids.kemkes.go.id/';
const SUBSTITUTION_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution';
/** The substitution reasons the hub sends (#9), as `system|code`. */
const SUBSTITUTION_REASONS = new Set([
  'http://terminology.hl7.org/CodeSystem/v3-ActReason|OS',
  'http://terminology.hl7.org/CodeSystem/v3-ActReason|FP',
  'http://terminology.kemkes.go.id|TK000017',
  'http://terminology.kemkes.go.id|TK000018',
  'http://snomed.info/sct|661000124108',
]);

/**
 * The mandatory fields (the union of the guide, the resource page and the
 * rule dictionary: identifier, status, medication, subject, context,
 * performer.actor, authorizingPrescription, quantity, whenPrepared,
 * whenHandedOver, substitution.wasSubstituted), the payload constant
 * (`completed`), `+00:00` times not before the floor, a batch (when sent)
 * with a lot and a plain expiry date not before the floor, exactly one
 * `prescription/{org}` and one `prescription-item/{org}` identifier of the
 * case's organization, exactly one authorizing MedicationRequest, and the
 * substitution as the hub sends it: `wasSubstituted` equal to
 * `judgedSubstituted` (the KFA judgement; null when the product was not
 * judged); no substitution is `{ wasSubstituted: false }` alone; a
 * substitution is of type `G`, has at least two responsible practitioners
 * (the requester and the pharmacist), and a known reason when it has one.
 */
export function checkMedicationDispense(body: unknown, organizationId: OrganizationId, judgedSubstituted: boolean | null, fail: Fail): void {
  if (!isObject(body)) return fail('MedicationDispense', `must be a JSON object, got ${describe(body)}`);
  const at = (path: string) => `MedicationDispense.${path}`;

  if (body.resourceType !== 'MedicationDispense') fail(at('resourceType'), `must be "MedicationDispense", got ${describe(body.resourceType)}`);
  for (const name of ['prescription', 'prescription-item']) {
    checkBusinessIdentifier(body.identifier, at('identifier'), `${SYSTEM_PREFIX}${name}/`, organizationId, fail);
  }
  if (body.status !== 'completed') fail(at('status'), `must be "completed", got ${describe(body.status)}`);
  if (!isReferenceTo(body.subject, 'Patient')) fail(at('subject'), `must reference "Patient/{ihs}", got ${describe(body.subject)}`);
  if (!isReferenceTo(body.context, 'Encounter')) fail(at('context'), `must reference "Encounter/{id}", got ${describe(body.context)}`);
  const performers = nonEmptyArray(body.performer) ?? [];
  if (performers.length === 0 || !performers.every((p) => isObject(p) && isReferenceTo(p.actor, 'Practitioner'))) {
    fail(at('performer'), `needs an actor referencing "Practitioner/{ihs}", got ${describe(body.performer)}`);
  }
  const prescriptions = nonEmptyArray(body.authorizingPrescription) ?? [];
  if (prescriptions.length !== 1 || !isReferenceTo(prescriptions[0], 'MedicationRequest')) {
    fail(at('authorizingPrescription'), `needs exactly one reference to "MedicationRequest/{id}", got ${describe(body.authorizingPrescription)}`);
  }
  for (const field of ['whenPrepared', 'whenHandedOver']) {
    if (body[field] === undefined) fail(at(field), 'is required');
    else checkTime(body[field], at(field), fail);
  }
  const quantity = isObject(body.quantity) ? body.quantity : {};
  if (typeof quantity.value !== 'number' || !(quantity.value > 0)) {
    fail(at('quantity'), `needs a value greater than 0, got ${describe(body.quantity)}`);
  } else if (!nonEmptyString(quantity.unit) || !nonEmptyString(quantity.code)) {
    fail(at('quantity'), `needs a unit and a code (the KFA dose form), got ${describe(body.quantity)}`);
  }

  const medication = containedMedication(body, 'MedicationDispense', fail);
  if (medication?.batch !== undefined) checkBatch(medication.batch, fail);
  checkSubstitution(body.substitution, judgedSubstituted, fail);
}

function checkBatch(batch: unknown, fail: Fail): void {
  const path = 'MedicationDispense.contained.Medication.batch';
  if (!isObject(batch)) return fail(path, `must be an object, got ${describe(batch)}`);
  if (!nonEmptyString(batch.lotNumber)) fail(`${path}.lotNumber`, `is required in a batch, got ${describe(batch.lotNumber)}`);
  checkPlainDate(batch.expirationDate, `${path}.expirationDate`, fail);
}

function checkSubstitution(value: unknown, judgedSubstituted: boolean | null, fail: Fail): void {
  const path = 'MedicationDispense.substitution';
  const substitution = isObject(value) ? value : {};
  const { wasSubstituted } = substitution;
  if (typeof wasSubstituted !== 'boolean') return fail(`${path}.wasSubstituted`, `is required as a boolean, got ${describe(wasSubstituted)}`);
  if (judgedSubstituted !== null && wasSubstituted !== judgedSubstituted) {
    fail(`${path}.wasSubstituted`, `must be ${judgedSubstituted}, as the KFA details judge the dispense, got ${wasSubstituted}`);
  }
  if (!wasSubstituted) {
    if (Object.keys(substitution).length !== 1) fail(path, `must be only { wasSubstituted: false } when not substituted, got ${describe(value)}`);
    return;
  }
  const typeCodings = isObject(substitution.type) ? (nonEmptyArray(substitution.type.coding) ?? []) : [];
  if (!typeCodings.some((c) => isObject(c) && c.system === SUBSTITUTION_TYPE_SYSTEM && c.code === 'G')) {
    fail(`${path}.type`, `must be ${SUBSTITUTION_TYPE_SYSTEM}|G, got ${describe(substitution.type)}`);
  }
  const parties = nonEmptyArray(substitution.responsibleParty) ?? [];
  if (parties.length < 2 || !parties.every((p) => isReferenceTo(p, 'Practitioner'))) {
    fail(`${path}.responsibleParty`, `must reference the requester and the pharmacist ("Practitioner/{ihs}"), got ${describe(substitution.responsibleParty)}`);
  }
  if (substitution.reason === undefined) return;
  const reasons = nonEmptyArray(substitution.reason) ?? [];
  const known = reasons.every(
    (r) => isObject(r) && (nonEmptyArray(r.coding) ?? []).some((c) => isObject(c) && SUBSTITUTION_REASONS.has(`${String(c.system)}|${String(c.code)}`)),
  );
  if (reasons.length === 0 || !known) fail(`${path}.reason`, `must be one of ${[...SUBSTITUTION_REASONS].join(', ')}, got ${describe(substitution.reason)}`);
}
