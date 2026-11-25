import { prescriptionItemSystem, prescriptionSystem, product93 } from './medication-requests.js';
import { world } from './platform.js';

export const SUBSTITUTION_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution';

/**
 * A submit-dispense payload that passes every mock rule: `product93` (the
 * product `validMedicationRequest` prescribes) dispensed, not substituted,
 * against the Encounter and MedicationRequest the mock holds.
 */
export function validMedicationDispense(encounterId: string, medicationRequestId: string, prescriptionId = 'RX-1', org = world.organization.id): any {
  const patient = world.patients[0]!;
  const pharmacist = world.practitioners.find((p) => p.role === 'pharmacist')!;
  return {
    resourceType: 'MedicationDispense',
    contained: [
      {
        resourceType: 'Medication',
        id: 'med',
        identifier: [{ system: `http://sys-ids.kemkes.go.id/medication/${org}`, use: 'official', value: `${prescriptionId}-1` }],
        code: { coding: [{ system: 'http://sys-ids.kemkes.go.id/kfa', code: product93.code, display: product93.display }] },
        status: 'active',
        extension: [
          {
            url: 'https://fhir.kemkes.go.id/r4/StructureDefinition/MedicationType',
            valueCodeableConcept: { coding: [{ system: 'http://terminology.kemkes.go.id/CodeSystem/medication-type', code: 'NC', display: 'Non-compound' }] },
          },
        ],
        batch: { lotNumber: 'LOT-1', expirationDate: '2028-01-31' },
      },
    ],
    identifier: [
      { system: prescriptionSystem(org), use: 'official', value: prescriptionId },
      { system: prescriptionItemSystem(org), use: 'official', value: `${prescriptionId}-1` },
    ],
    status: 'completed',
    medicationReference: { reference: '#med', display: product93.display },
    subject: { reference: `Patient/${patient.ihs}` },
    context: { reference: `Encounter/${encounterId}` },
    performer: [{ actor: { reference: `Practitioner/${pharmacist.ihs}` } }],
    authorizingPrescription: [{ reference: `MedicationRequest/${medicationRequestId}` }],
    quantity: { value: 10, unit: product93.doseForm!.name, system: 'http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm', code: product93.doseForm!.code },
    whenPrepared: '2026-03-01T03:00:00+00:00',
    whenHandedOver: '2026-03-01T03:10:00+00:00',
    substitution: { wasSubstituted: false },
  };
}

/** Turns `md` into a substitution by `code`: type G, reason OS, the prescriber and the pharmacist responsible. */
export function substitutedTo(md: any, code: string): any {
  const product = world.kfaProducts.find((p) => p.code === code)!;
  md.contained[0].code.coding[0] = { system: 'http://sys-ids.kemkes.go.id/kfa', code: product.code, display: product.display };
  md.substitution = {
    wasSubstituted: true,
    type: { coding: [{ system: SUBSTITUTION_TYPE_SYSTEM, code: 'G' }] },
    reason: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'OS' }] }],
    responsibleParty: [{ reference: `Practitioner/${world.practitioners[0]!.ihs}` }, md.performer[0].actor],
  };
  return md;
}
