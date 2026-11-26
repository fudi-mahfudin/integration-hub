// The hub's PAYLOAD_INVALID rules for a MedicationRequest (#9). Internal to
// the Validation module: callers go through `validateStepPayload`.
import type { OrganizationId } from '../auth/source-systems.js';
import { checkTime, describe, isObject, isReferenceTo, nonEmptyArray, nonEmptyString, type Fail } from './payload-checks.js';

// Written out here, not imported from the builder in satusehat/resources.ts:
// the check must not trust the code it checks.
const SYSTEM_PREFIX = 'http://sys-ids.kemkes.go.id/';
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';
const CATEGORY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/medicationrequest-category';

/**
 * The mandatory fields (the union of the guide, the resource page and the
 * rule dictionary: identifier, status, intent, category, medication,
 * subject, encounter, authoredOn, requester, dispenseRequest.performer,
 * substitution.allowedBoolean), the payload constants (`completed`, `order`,
 * `community`, substitution allowed), a `+00:00` authoredOn not before the floor, exactly one `prescription/{org}`
 * and one `prescription-item/{org}` identifier of the case's organization,
 * the case's organization as the dispense performer, a contained Medication
 * coded by KFA, and a positive quantity with a unit.
 */
export function checkMedicationRequest(body: unknown, organizationId: OrganizationId, fail: Fail): void {
  if (!isObject(body)) return fail('MedicationRequest', `must be a JSON object, got ${describe(body)}`);
  const at = (path: string) => `MedicationRequest.${path}`;

  if (body.resourceType !== 'MedicationRequest') fail(at('resourceType'), `must be "MedicationRequest", got ${describe(body.resourceType)}`);
  for (const name of ['prescription', 'prescription-item']) checkIdentifier(body.identifier, `${SYSTEM_PREFIX}${name}/`, organizationId, fail);
  // The hub's payload constants (#9): a completed order in the community category, substitution allowed.
  if (body.status !== 'completed') fail(at('status'), `must be "completed", got ${describe(body.status)}`);
  if (body.intent !== 'order') fail(at('intent'), `must be "order", got ${describe(body.intent)}`);
  const community = (nonEmptyArray(body.category) ?? []).some(
    (c) =>
      isObject(c) &&
      (nonEmptyArray(c.coding) ?? []).some((coding) => isObject(coding) && coding.system === CATEGORY_SYSTEM && coding.code === 'community'),
  );
  if (!community) fail(at('category'), `must be ${CATEGORY_SYSTEM}|community, got ${describe(body.category)}`);
  const substitution = isObject(body.substitution) ? body.substitution : {};
  if (substitution.allowedBoolean !== true) {
    fail(at('substitution.allowedBoolean'), `must be true, got ${describe(substitution.allowedBoolean)}`);
  }
  if (!isReferenceTo(body.subject, 'Patient')) fail(at('subject'), `must reference "Patient/{ihs}", got ${describe(body.subject)}`);
  if (!isReferenceTo(body.encounter, 'Encounter')) fail(at('encounter'), `must reference "Encounter/{id}", got ${describe(body.encounter)}`);
  if (!isReferenceTo(body.requester, 'Practitioner')) {
    fail(at('requester'), `must reference "Practitioner/{ihs}", got ${describe(body.requester)}`);
  }
  if (body.authoredOn === undefined) fail(at('authoredOn'), 'is required');
  else checkTime(body.authoredOn, at('authoredOn'), fail);
  checkMedication(body, fail);

  const dispenseRequest = isObject(body.dispenseRequest) ? body.dispenseRequest : {};
  const expectedPerformer = `Organization/${organizationId}`;
  if (!isReferenceTo(dispenseRequest.performer, 'Organization') || dispenseRequest.performer.reference !== expectedPerformer) {
    fail(at('dispenseRequest.performer'), `must reference "${expectedPerformer}", the case's organization, got ${describe(dispenseRequest.performer)}`);
  }
  const quantity = isObject(dispenseRequest.quantity) ? dispenseRequest.quantity : {};
  if (typeof quantity.value !== 'number' || !(quantity.value > 0)) {
    fail(at('dispenseRequest.quantity.value'), `must be a number greater than 0, got ${describe(quantity.value)}`);
  }
  if (!nonEmptyString(quantity.unit) || !nonEmptyString(quantity.code)) {
    fail(at('dispenseRequest.quantity'), `needs a unit and a code (the KFA dose form), got ${describe(dispenseRequest.quantity)}`);
  }
}

function checkIdentifier(identifier: unknown, prefix: string, organizationId: OrganizationId, fail: Fail): void {
  const path = 'MedicationRequest.identifier';
  const expectedSystem = `${prefix}${organizationId}`;
  const matching = (nonEmptyArray(identifier) ?? []).filter(
    (id) => isObject(id) && typeof id.system === 'string' && id.system.startsWith(prefix) && /^\d+$/.test(id.system.slice(prefix.length)),
  );
  const [only] = matching;
  if (matching.length !== 1 || !isObject(only)) return fail(path, `needs exactly one identifier under ${prefix}{org}, got ${matching.length}`);
  if (only.system !== expectedSystem) fail(path, `system must be ${expectedSystem}, the case's organization, got ${describe(only.system)}`);
  if (!nonEmptyString(only.value)) fail(path, `the ${expectedSystem} identifier needs a value, got ${describe(only.value)}`);
}

function checkMedication(body: Record<string, unknown>, fail: Fail): void {
  const path = 'MedicationRequest.medicationReference';
  const reference = isObject(body.medicationReference) ? body.medicationReference.reference : undefined;
  if (typeof reference !== 'string' || !reference.startsWith('#')) {
    return fail(path, `must reference a contained Medication ("#{id}"), got ${describe(body.medicationReference)}`);
  }
  const medication = (nonEmptyArray(body.contained) ?? []).find(
    (c) => isObject(c) && c.resourceType === 'Medication' && c.id === reference.slice(1),
  );
  if (!isObject(medication)) return fail(path, `references ${describe(reference)}, which is not a contained Medication`);
  const codings = isObject(medication.code) ? (nonEmptyArray(medication.code.coding) ?? []) : [];
  if (!codings.some((c) => isObject(c) && c.system === KFA_SYSTEM && nonEmptyString(c.code))) {
    fail('MedicationRequest.contained.Medication.code', `needs a coding under ${KFA_SYSTEM}, got ${describe(medication.code)}`);
  }
}
