import { world } from './platform.js';

export const prescriptionSystem = (org = world.organization.id): string => `http://sys-ids.kemkes.go.id/prescription/${org}`;
export const prescriptionItemSystem = (org = world.organization.id): string => `http://sys-ids.kemkes.go.id/prescription-item/${org}`;

/** A world 93 product with a dose form. */
export const product93 = world.kfaProducts.find((p) => p.level === 93)!;

/**
 * A submit-prescription payload that passes every mock rule, for the
 * Encounter `encounterId` the mock holds; tests break it one field at a time.
 */
export function validMedicationRequest(encounterId: string, prescriptionId = 'RX-1', org = world.organization.id): any {
  const patient = world.patients[0]!;
  const doctor = world.practitioners[0]!;
  const unit = { unit: product93.doseForm!.name, system: 'http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm', code: product93.doseForm!.code };
  return {
    resourceType: 'MedicationRequest',
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
      },
    ],
    identifier: [
      { system: prescriptionSystem(org), use: 'official', value: prescriptionId },
      { system: prescriptionItemSystem(org), use: 'official', value: `${prescriptionId}-1` },
    ],
    status: 'completed',
    intent: 'order',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }] }],
    medicationReference: { reference: '#med', display: product93.display },
    subject: { reference: `Patient/${patient.ihs}` },
    encounter: { reference: `Encounter/${encounterId}` },
    authoredOn: '2026-03-01T02:30:00+00:00',
    requester: { reference: `Practitioner/${doctor.ihs}` },
    dosageInstruction: [
      {
        sequence: 1,
        text: '3 x 1 tablet',
        timing: { repeat: { frequency: 3, period: 1, periodUnit: 'd' } },
        route: { coding: [{ system: 'http://www.whocc.no/atc', code: 'O', display: 'Oral' }] },
        doseAndRate: [{ doseQuantity: { value: 1, ...unit } }],
      },
    ],
    dispenseRequest: { quantity: { value: 10, ...unit }, performer: { reference: `Organization/${org}` } },
    substitution: { allowedBoolean: true },
  };
}
