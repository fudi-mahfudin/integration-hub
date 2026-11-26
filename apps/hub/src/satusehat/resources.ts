import type { OrganizationId } from '../auth/source-systems.js';
import type { RemoteIdentifier } from '../cases/case-model.js';
import type { KfaDetails } from '../kfa/kfa-product.js';
import type { IhsNumber, LocationId, PrescriptionIdentifier, VisitIdentifier } from './client.js';
import { platformTime } from './platform-time.js';

/** A FHIR resource as the hub builds it, to be checked by the Validation module and then sent. */
export type FhirResource = Record<string, unknown>;

/** The `encounter/{org}` identifier system of an organization's visits. */
export const encounterSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/encounter/${org}`;

/** The `prescription/{org}` identifier system of an organization's prescriptions. */
export const prescriptionSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/prescription/${org}`;

/** The `prescription-item/{org}` identifier system of an organization's prescription items. */
export const prescriptionItemSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/prescription-item/${org}`;

/** The `medication/{org}` identifier system of an organization's Medications. */
export const medicationSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/medication/${org}`;

/** The coding system of KFA codes. */
export const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';

/** The coding system of KFA dose forms. */
const MEDICATION_FORM_SYSTEM = 'http://terminology.kemkes.go.id/CodeSystem/medication-form';

const CLASS_DISPLAY = { AMB: 'ambulatory', IMP: 'inpatient encounter', EMER: 'emergency' } as const;

/** The encounter classes a visit may have (#6). */
export type EncounterClass = 'AMB' | 'IMP' | 'EMER';

/** What a create-visit Encounter says about its visit. */
export interface VisitEncounter {
  identifier: VisitIdentifier;
  encounterClass: EncounterClass;
  patient: IhsNumber;
  practitioner: IhsNumber;
  location: LocationId;
  startedAt: Date;
}

/** The FHIR R4 Encounter of a visit that has just started. */
export function visitEncounterResource(e: VisitEncounter): FhirResource {
  const start = platformTime(e.startedAt);
  return {
    resourceType: 'Encounter',
    identifier: [{ system: encounterSystem(e.identifier.organizationId), value: e.identifier.visitId }],
    status: 'arrived',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: e.encounterClass,
      display: CLASS_DISPLAY[e.encounterClass],
    },
    subject: { reference: `Patient/${e.patient}` },
    participant: [
      {
        type: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' },
            ],
          },
        ],
        individual: { reference: `Practitioner/${e.practitioner}` },
      },
    ],
    period: { start },
    location: [{ location: { reference: `Location/${e.location}` } }],
    statusHistory: [{ status: 'arrived', period: { start } }],
    serviceProvider: { reference: `Organization/${e.identifier.organizationId}` },
  };
}

/** What a prescription's MedicationRequest says: the one drug item, on the visit's Encounter. */
export interface PrescriptionRequest {
  identifier: PrescriptionIdentifier;
  itemId: string;
  /** The Encounter create visit stored. */
  encounter: RemoteIdentifier;
  /** The patient create visit pinned. */
  patient: IhsNumber;
  requester: IhsNumber;
  authoredAt: Date;
  /** The KFA details of the mapped drug code. */
  medication: KfaDetails;
  quantity: number;
  dosage: { text: string; timesPerDay: number; doseAmount: number; routeCode: string };
}

/**
 * The FHIR R4 MedicationRequest of a single-item prescription (#9): `completed`,
 * an `order` in the `community` category, substitution allowed, the drug as a
 * contained Medication coded by KFA, and quantities counted in the KFA dose form.
 */
export function prescriptionMedicationRequestResource(p: PrescriptionRequest): FhirResource {
  const org = p.identifier.organizationId;
  const { product, display, doseForm } = p.medication;
  const unit = doseForm ? { unit: doseForm.display, system: MEDICATION_FORM_SYSTEM, code: doseForm.code } : {};
  return {
    resourceType: 'MedicationRequest',
    contained: [
      {
        resourceType: 'Medication',
        id: 'medication',
        identifier: [{ system: medicationSystem(org), use: 'official', value: `${p.identifier.prescriptionId}-${p.itemId}` }],
        code: { coding: [{ system: KFA_SYSTEM, code: product.code, display }] },
        status: 'active',
        ...(doseForm ? { form: { coding: [{ system: MEDICATION_FORM_SYSTEM, code: doseForm.code, display: doseForm.display }] } } : {}),
      },
    ],
    identifier: [
      { system: prescriptionSystem(org), use: 'official', value: p.identifier.prescriptionId },
      { system: prescriptionItemSystem(org), use: 'official', value: p.itemId },
    ],
    status: 'completed',
    intent: 'order',
    category: [
      {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }],
      },
    ],
    medicationReference: { reference: '#medication', display },
    subject: { reference: `Patient/${p.patient}` },
    encounter: { reference: `Encounter/${p.encounter.id}` },
    authoredOn: platformTime(p.authoredAt),
    requester: { reference: `Practitioner/${p.requester}` },
    dosageInstruction: [
      {
        sequence: 1,
        text: p.dosage.text,
        timing: { repeat: { frequency: p.dosage.timesPerDay, period: 1, periodUnit: 'd' } },
        route: { coding: [{ system: 'http://www.whocc.no/atc', code: p.dosage.routeCode }] },
        doseAndRate: [{ doseQuantity: { value: p.dosage.doseAmount, ...unit } }],
      },
    ],
    dispenseRequest: {
      quantity: { value: p.quantity, ...unit },
      performer: { reference: `Organization/${org}` },
    },
    substitution: { allowedBoolean: true },
  };
}
