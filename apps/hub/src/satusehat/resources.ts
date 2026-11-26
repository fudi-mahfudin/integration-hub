import type { OrganizationId } from '../auth/source-systems.js';
import type { PrescriptionItemId, RemoteIdentifier } from '../cases/case-model.js';
import type { SubstitutionReason } from '../ingestion/event-schema.js';
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
const prescriptionItemSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/prescription-item/${org}`;

/** The `medication/{org}` identifier system of an organization's Medications. */
const medicationSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/medication/${org}`;

/** The coding system of KFA codes. */
const KFA_SYSTEM = 'http://sys-ids.kemkes.go.id/kfa';

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
  itemId: PrescriptionItemId;
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
  const { display } = p.medication;
  const unit = doseFormUnit(p.medication);
  return {
    resourceType: 'MedicationRequest',
    contained: [containedMedication(p.identifier, p.itemId, p.medication, null)],
    identifier: prescriptionIdentifiers(p.identifier, p.itemId),
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

/** The quantity unit of a KFA product: its dose form, when it has one. */
function doseFormUnit({ doseForm }: KfaDetails): { unit: string; system: string; code: string } | Record<string, never> {
  return doseForm ? { unit: doseForm.display, system: MEDICATION_FORM_SYSTEM, code: doseForm.code } : {};
}

/** The `prescription/{org}` and `prescription-item/{org}` identifiers a prescription and its dispense both carry (#9). */
function prescriptionIdentifiers(identifier: PrescriptionIdentifier, itemId: PrescriptionItemId) {
  const org = identifier.organizationId;
  return [
    { system: prescriptionSystem(org), use: 'official', value: identifier.prescriptionId },
    { system: prescriptionItemSystem(org), use: 'official', value: itemId },
  ];
}

/** The contained Medication `#medication`, coded by KFA, with its batch when one is known. */
function containedMedication(identifier: PrescriptionIdentifier, itemId: PrescriptionItemId, medication: KfaDetails, batch: Batch | null): FhirResource {
  const { product, display, doseForm } = medication;
  return {
    resourceType: 'Medication',
    id: 'medication',
    identifier: [{ system: medicationSystem(identifier.organizationId), use: 'official', value: `${identifier.prescriptionId}-${itemId}` }],
    code: { coding: [{ system: KFA_SYSTEM, code: product.code, display }] },
    status: 'active',
    ...(doseForm ? { form: { coding: [{ system: MEDICATION_FORM_SYSTEM, code: doseForm.code, display: doseForm.display }] } } : {}),
    ...(batch ? { batch: { lotNumber: batch.lot, expirationDate: batch.expiry } } : {}),
  };
}

/** A batch handed over: its lot and its expiry, a plain `YYYY-MM-DD` date that is never converted (#9). */
export interface Batch {
  lot: string;
  expiry: string;
}

/** Where each source substitution reason goes in `substitution.reason` (#9). */
const SUBSTITUTION_REASON_CODING: Record<SubstitutionReason, { system: string; code: string }> = {
  OS: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'OS' },
  FP: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'FP' },
  DRUG_INTERACTION: { system: 'http://terminology.kemkes.go.id', code: 'TK000017' },
  PATIENT_CHOICE: { system: 'http://terminology.kemkes.go.id', code: 'TK000018' },
  PRESCRIPTION_ERROR: { system: 'http://snomed.info/sct', code: '661000124108' },
};

/** What a dispense's MedicationDispense says: the drug handed over for the case's one prescription item. */
export interface DispenseRecord {
  /** The prescription it fills: its MedicationDispense reuses the prescription's identifiers (#9). */
  identifier: PrescriptionIdentifier;
  /** The prescription item it fills: the `prescription-item/{org}` identifier's value. */
  itemId: PrescriptionItemId;
  /** The Encounter create visit stored. */
  encounter: RemoteIdentifier;
  /** The MedicationRequest submit prescription stored. */
  medicationRequest: RemoteIdentifier;
  /** The patient create visit pinned. */
  patient: IhsNumber;
  /** The pharmacist who dispensed: the performer, and responsible for a substitution. */
  pharmacist: IhsNumber;
  /** The KFA details of the dispensed drug code. */
  medication: KfaDetails;
  /** How much was handed over, counted in the dispensed product's dose form. */
  quantity: number;
  /** `whenPrepared`. */
  preparedAt: Date;
  /** `whenHandedOver`. */
  handedOverAt: Date;
  /** The batch handed over, on the contained Medication; null when the source sent none. */
  batch: Batch | null;
  /**
   * Null when the hub judged the dispense no substitution; otherwise the
   * source's reason and the requester submit prescription pinned. The reason
   * is null when the source declared none: that payload is built only so the
   * attempt log shows what the hub decided, and SUBSTITUTION_MISMATCH keeps
   * it from being sent.
   */
  substitution: { reasonCode: SubstitutionReason | null; requester: IhsNumber } | null;
}

/**
 * The FHIR R4 MedicationDispense of a single-item dispense (#9): `completed`,
 * authorized by the case's MedicationRequest, the drug as a contained
 * Medication coded by KFA with its batch, the quantity in its dose form, and
 * the substitution: `{ wasSubstituted: false }` alone, or type `G` with the
 * mapped reason and the requester and pharmacist responsible.
 */
export function dispenseMedicationDispenseResource(d: DispenseRecord): FhirResource {
  const pharmacist = { reference: `Practitioner/${d.pharmacist}` };
  const substitution = d.substitution
    ? {
        wasSubstituted: true,
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution', code: 'G' }] },
        ...(d.substitution.reasonCode ? { reason: [{ coding: [SUBSTITUTION_REASON_CODING[d.substitution.reasonCode]] }] } : {}),
        responsibleParty: [{ reference: `Practitioner/${d.substitution.requester}` }, pharmacist],
      }
    : { wasSubstituted: false };
  return {
    resourceType: 'MedicationDispense',
    contained: [containedMedication(d.identifier, d.itemId, d.medication, d.batch)],
    identifier: prescriptionIdentifiers(d.identifier, d.itemId),
    status: 'completed',
    medicationReference: { reference: '#medication', display: d.medication.display },
    subject: { reference: `Patient/${d.patient}` },
    context: { reference: `Encounter/${d.encounter.id}` },
    performer: [{ actor: pharmacist }],
    authorizingPrescription: [{ reference: `MedicationRequest/${d.medicationRequest.id}` }],
    quantity: { value: d.quantity, ...doseFormUnit(d.medication) },
    whenPrepared: platformTime(d.preparedAt),
    whenHandedOver: platformTime(d.handedOverAt),
    substitution,
  };
}
