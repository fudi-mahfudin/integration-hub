import { KFA_SYSTEM, MEDICATION_TYPE_URL, sysIdSystem } from '../satusehat/systems.js';
import { checkTime, isObject, reference, text, type Fail } from './payload-checks.js';
import type { Violation } from './validation.js';

/**
 * MedicationRequest payload rules (#9, the mandatory-field union of #2):
 * identifiers, status/intent, the contained non-compound Medication with a
 * KFA code, the references, authoredOn, dosage timing and route,
 * dispenseRequest.performer and substitution.allowedBoolean. The KFA level
 * is the medication rule's (`KFA_LEVEL_INVALID`), not a payload rule.
 */

const STATUSES = ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'];
const INTENTS = ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'];

export function medicationRequestRules(m: Record<string, any>, organizationId: string): Violation[] {
  const out: Violation[] = [];
  const fail: Fail = (rule, path, message) => out.push({ code: 'PAYLOAD_INVALID', rule, path, message });

  prescriptionIdentifiers(m, 'MedicationRequest', organizationId, fail);

  oneOf(m.status, STATUSES, 'MedicationRequest.status', fail);
  oneOf(m.intent, INTENTS, 'MedicationRequest.intent', fail);

  containedMedication(m, 'MedicationRequest', organizationId, fail);

  reference(m.subject, 'Patient', 'MedicationRequest.subject.reference', fail);
  reference(m.encounter, 'Encounter', 'MedicationRequest.encounter.reference', fail);
  reference(m.requester, 'Practitioner', 'MedicationRequest.requester.reference', fail);

  if (m.authoredOn === undefined) fail('REQUIRED', 'MedicationRequest.authoredOn', 'authoredOn is required');
  else checkTime(m.authoredOn, 'MedicationRequest.authoredOn', fail);

  const dosages: any[] = Array.isArray(m.dosageInstruction) ? m.dosageInstruction : [];
  if (dosages.length === 0) fail('REQUIRED', 'MedicationRequest.dosageInstruction', 'a dosage instruction is required');
  dosages.forEach((d, i) => {
    const path = `MedicationRequest.dosageInstruction[${i}]`;
    if (!isObject(d?.timing?.repeat)) fail('REQUIRED', `${path}.timing.repeat`, 'timing.repeat is required');
    if (!Array.isArray(d?.route?.coding) || !d.route.coding.some((c: any) => text(c?.code))) fail('REQUIRED', `${path}.route`, 'route is required');
  });

  // The quantity the source sent, in the KFA product's dose form (#6): no unit means no dose form to take it from.
  const quantity = isObject(m.dispenseRequest) ? m.dispenseRequest.quantity : undefined;
  if (!isObject(quantity) || typeof quantity.value !== 'number') {
    fail('REQUIRED', 'MedicationRequest.dispenseRequest.quantity.value', 'dispenseRequest.quantity.value is required');
  }
  if (!isObject(quantity) || !text(quantity.code)) {
    fail('REQUIRED', 'MedicationRequest.dispenseRequest.quantity.code', 'dispenseRequest.quantity needs a unit code (the dose form)');
  }

  const performer = isObject(m.dispenseRequest) ? m.dispenseRequest.performer : undefined;
  if (reference(performer, 'Organization', 'MedicationRequest.dispenseRequest.performer.reference', fail)) {
    if (performer.reference !== `Organization/${organizationId}`) {
      fail('IDENTIFIER_SYSTEM', 'MedicationRequest.dispenseRequest.performer.reference', `performer must be Organization/${organizationId}`);
    }
  }

  if (typeof m.substitution?.allowedBoolean !== 'boolean') {
    fail('REQUIRED', 'MedicationRequest.substitution.allowedBoolean', 'substitution.allowedBoolean is required');
  }
  return out;
}

/** `prescription/{org}` and `prescription-item/{org}`, each valued: MedicationRequest and MedicationDispense alike (#9). */
export function prescriptionIdentifiers(m: Record<string, any>, type: string, organizationId: string, fail: Fail): void {
  const identifiers: any[] = Array.isArray(m.identifier) ? m.identifier : [];
  if (identifiers.length === 0) return fail('REQUIRED', `${type}.identifier`, 'identifier is required');
  for (const kind of ['prescription', 'prescription-item'] as const) {
    const system = sysIdSystem(kind, organizationId);
    const i = identifiers.findIndex((x) => x?.system === system);
    if (i < 0) fail('IDENTIFIER_SYSTEM', `${type}.identifier`, `needs an identifier with system ${system}`);
    else if (!text(identifiers[i].value)) fail('REQUIRED', `${type}.identifier[${i}].value`, 'identifier value is required');
  }
}

/** `medicationReference` to a contained Medication, checked by `medicationRules`; returns that Medication. */
export function containedMedication(m: Record<string, any>, type: string, organizationId: string, fail: Fail): Record<string, any> | undefined {
  const path = `${type}.medicationReference.reference`;
  if (!isObject(m.medicationReference) || !text(m.medicationReference.reference)) {
    fail('REQUIRED', path, 'medicationReference is required');
    return undefined;
  }
  const ref = String(m.medicationReference.reference);
  const contained: any[] = Array.isArray(m.contained) ? m.contained : [];
  const med = ref.startsWith('#') ? contained.find((c) => c?.resourceType === 'Medication' && c.id === ref.slice(1)) : undefined;
  if (!med) fail('REFERENCE', path, 'must reference a contained Medication (#id)');
  else medicationRules(med, organizationId, fail);
  return med;
}

/** The contained non-compound Medication: `medication/{org}` identifier, a KFA code, the NC type. */
function medicationRules(med: Record<string, any>, organizationId: string, fail: Fail): void {
  const system = sysIdSystem('medication', organizationId);
  const ids: any[] = Array.isArray(med.identifier) ? med.identifier : [];
  if (!ids.some((i) => i?.system === system && text(i.value))) fail('IDENTIFIER_SYSTEM', 'Medication.identifier', `needs a valued identifier with system ${system}`);
  const codings: any[] = Array.isArray(med.code?.coding) ? med.code.coding : [];
  if (!codings.some((c) => c?.system === KFA_SYSTEM && text(c.code))) fail('REQUIRED', 'Medication.code', `code needs a coding with system ${KFA_SYSTEM}`);
  const exts: any[] = Array.isArray(med.extension) ? med.extension : [];
  const nonCompound = exts.some(
    (e) => e?.url === MEDICATION_TYPE_URL && Array.isArray(e.valueCodeableConcept?.coding) && e.valueCodeableConcept.coding.some((c: any) => c?.code === 'NC'),
  );
  if (!nonCompound) fail('REQUIRED', 'Medication.extension', 'needs the MedicationType extension with code NC');
}

export function oneOf(value: unknown, allowed: string[], path: string, fail: Fail): void {
  if (!text(value)) fail('REQUIRED', path, `${path.split('.').pop()} is required`);
  else if (!allowed.includes(value)) fail('VALUE_SET', path, `${value} is not allowed`);
}
