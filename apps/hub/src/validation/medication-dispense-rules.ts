import { containedMedication, oneOf, prescriptionIdentifiers } from './medication-request-rules.js';
import { checkTime, isObject, reference, text, type Fail } from './payload-checks.js';
import type { Violation } from './validation.js';

/**
 * MedicationDispense payload rules (#9, the mandatory-field union of #2):
 * the prescription identifiers, status, the contained Medication (with an
 * optional batch whose expiry is a plain date under the floor), subject,
 * context, the pharmacist performer, authorizingPrescription (always sent),
 * quantity in a dose form, both times, and the substitution block: type G,
 * one of the five reasons and the requester + pharmacist responsible, or
 * only `{ wasSubstituted: false }`. Whether it is a substitution at all is the
 * medication rule's (`UNSUPPORTED_THERAPEUTIC_SUBSTITUTION`, `SUBSTITUTION_MISMATCH`).
 */

const STATUSES = ['preparation', 'in-progress', 'cancelled', 'on-hold', 'completed', 'entered-in-error', 'stopped', 'declined', 'unknown'];
export const SUBSTITUTION_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution';
const ACT_REASON_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActReason';
const KEMKES_TERMINOLOGY = 'http://terminology.kemkes.go.id';

/** `drug.dispensed.substitution.reasonCode` → `MedicationDispense.substitution.reason` coding (#9). */
export const SUBSTITUTION_REASONS: Record<string, { system: string; code: string; display: string }> = {
  OS: { system: ACT_REASON_SYSTEM, code: 'OS', display: 'out of stock' },
  FP: { system: ACT_REASON_SYSTEM, code: 'FP', display: 'formulary policy' },
  DRUG_INTERACTION: { system: KEMKES_TERMINOLOGY, code: 'TK000017', display: 'Interaksi obat berbahaya' },
  PATIENT_CHOICE: { system: KEMKES_TERMINOLOGY, code: 'TK000018', display: 'Pilihan pasien' },
  PRESCRIPTION_ERROR: { system: 'http://snomed.info/sct', code: '661000124108', display: 'Error in prescription' },
};
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FLOOR_DAY = '2014-06-03';

export function medicationDispenseRules(m: Record<string, any>, organizationId: string): Violation[] {
  const out: Violation[] = [];
  const fail: Fail = (rule, path, message) => out.push({ code: 'PAYLOAD_INVALID', rule, path, message });

  prescriptionIdentifiers(m, 'MedicationDispense', organizationId, fail);
  oneOf(m.status, STATUSES, 'MedicationDispense.status', fail);

  const med = containedMedication(m, 'MedicationDispense', organizationId, fail);
  if (med?.batch !== undefined) batchRules(med.batch, fail);

  reference(m.subject, 'Patient', 'MedicationDispense.subject.reference', fail);
  reference(m.context, 'Encounter', 'MedicationDispense.context.reference', fail);
  const performer = Array.isArray(m.performer) ? m.performer[0]?.actor : undefined;
  reference(performer, 'Practitioner', 'MedicationDispense.performer[0].actor.reference', fail);
  const prescription = Array.isArray(m.authorizingPrescription) ? m.authorizingPrescription[0] : undefined;
  reference(prescription, 'MedicationRequest', 'MedicationDispense.authorizingPrescription[0].reference', fail);

  if (!isObject(m.quantity) || typeof m.quantity.value !== 'number') fail('REQUIRED', 'MedicationDispense.quantity.value', 'quantity.value is required');
  if (!isObject(m.quantity) || !text(m.quantity.code)) fail('REQUIRED', 'MedicationDispense.quantity.code', 'quantity needs a unit code (the dose form)');

  for (const field of ['whenPrepared', 'whenHandedOver']) {
    const path = `MedicationDispense.${field}`;
    if (m[field] === undefined) fail('REQUIRED', path, `${field} is required`);
    else checkTime(m[field], path, fail);
  }

  substitutionRules(m.substitution, fail);
  return out;
}

/** Lot and expiry, both; the expiry a plain date, not before the floor (#9). */
function batchRules(batch: unknown, fail: Fail): void {
  if (!isObject(batch)) return fail('REQUIRED', 'Medication.batch', 'batch must be an object');
  if (!text(batch.lotNumber)) fail('REQUIRED', 'Medication.batch.lotNumber', 'batch.lotNumber is required');
  const expiry = batch.expirationDate;
  if (expiry === undefined) return fail('REQUIRED', 'Medication.batch.expirationDate', 'batch.expirationDate is required');
  if (typeof expiry !== 'string' || !DATE.test(expiry)) fail('TIME_FORMAT', 'Medication.batch.expirationDate', 'must be a plain date YYYY-MM-DD');
  else if (expiry < FLOOR_DAY) fail('DATE_FLOOR', 'Medication.batch.expirationDate', `must not be before ${FLOOR_DAY}`);
}

function substitutionRules(s: any, fail: Fail): void {
  const path = 'MedicationDispense.substitution';
  if (!isObject(s) || typeof s.wasSubstituted !== 'boolean') return fail('REQUIRED', `${path}.wasSubstituted`, 'substitution.wasSubstituted is required');
  if (!s.wasSubstituted) {
    if (Object.keys(s).some((k) => k !== 'wasSubstituted')) fail('VALUE_SET', path, 'a dispense that is not a substitution carries only { wasSubstituted: false }');
    return;
  }

  const types: any[] = Array.isArray(s.type?.coding) ? s.type.coding : [];
  if (types.length === 0) fail('REQUIRED', `${path}.type`, 'substitution.type is required');
  else if (!types.some((c) => c?.system === SUBSTITUTION_TYPE_SYSTEM && c.code === 'G')) fail('VALUE_SET', `${path}.type`, `type must be ${SUBSTITUTION_TYPE_SYSTEM} G`);

  const reasons: any[] = Array.isArray(s.reason) ? s.reason.flatMap((r: any) => (Array.isArray(r?.coding) ? r.coding : [])) : [];
  const known = Object.values(SUBSTITUTION_REASONS);
  if (reasons.length === 0) fail('REQUIRED', `${path}.reason`, 'substitution.reason is required');
  else if (!reasons.every((c) => known.some((k) => k.system === c?.system && k.code === c?.code))) {
    fail('VALUE_SET', `${path}.reason`, 'reason must be v3-ActReason OS or FP, TK000017, TK000018 or SNOMED 661000124108');
  }

  // The requester and the pharmacist (#9).
  const parties: any[] = Array.isArray(s.responsibleParty) ? s.responsibleParty : [];
  if (parties.length < 2) fail('REQUIRED', `${path}.responsibleParty`, 'the requester and the pharmacist are both responsible');
  parties.forEach((p, i) => reference(p, 'Practitioner', `${path}.responsibleParty[${i}].reference`, fail));
}
