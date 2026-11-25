import { findIhsNumber, type SourcePerson } from '../lookup/people.js';
import { kfaProduct } from '../mapping/kfa-products.js';
import { findKfaCode } from '../mapping/mappings.js';
import { sourceToPlatformTime } from '../time.js';
import { KFA_SYSTEM, MEDICATION_TYPE_URL } from '../validation/medication-request-rules.js';
import type { KfaProduct, MappingUse } from '../validation/validation.js';
import type { CreateVisitPins } from './create-visit.js';
import { checkStep, completedStep, searchThenCreate, sourceEvent, type DeadLettered, type StepRunner } from './step-runner.js';

/** `http://sys-ids.kemkes.go.id/prescription/{org}`: the prescription's identifier system (#6, #9). */
export const prescriptionSystem = (organizationId: string) => `http://sys-ids.kemkes.go.id/prescription/${organizationId}`;
const prescriptionItemSystem = (organizationId: string) => `http://sys-ids.kemkes.go.id/prescription-item/${organizationId}`;
const medicationSystem = (organizationId: string) => `http://sys-ids.kemkes.go.id/medication/${organizationId}`;
/** Quantity units are dose forms (#6); the mock world's dose-form codes are v3-orderableDrugForm codes. */
const DOSE_FORM_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm';
const ROUTE_SYSTEM = 'http://www.whocc.no/atc';

/** What submit prescription pins on completion (#10); submit dispense compares against these, never the live mapping. */
export interface SubmitPrescriptionPins {
  [pin: string]: unknown;
  kfaCode: string;
  kfaLevel: number;
  parent92: string | null;
  /** The prescribed product's 91 set, sorted. */
  ingredients: string[];
  requesterIhs: string;
}

interface PrescriptionWritten {
  prescriptionId: string;
  authoredAt: string;
  requester: SourcePerson;
  items: [{ itemId: string; drugCode: string; quantity: number; dosage: { text: string; timesPerDay: number; doseAmount: number; routeCode: string } }];
}

/**
 * Submit prescription: `prescription.written` → MedicationRequest. Maps the
 * local drug code to KFA (operator mapping), takes the KFA details from the
 * store or KFA v2, checks the KFA level before any platform call, looks up
 * the requester, builds the MedicationRequest against the visit's Encounter
 * and patient (create visit's remote id and pins), validates it, then
 * searches it by `prescription/{org}` and creates it only if absent.
 */
export const submitPrescription: StepRunner = async (step, { db, fhir, kfa, clock }, { used }) => {
  const data = (await sourceEvent(db, step.caseId, 'prescription.written')).data as PrescriptionWritten;
  const item = data.items[0];
  const organizationId = step.organizationId;

  // Local data and KFA first, so a missing mapping or a wrong level never reaches FHIR.
  const kfaCode = await findKfaCode(db, step.sourceId, item.drugCode);
  const drug: Record<string, unknown> = { localCode: item.drugCode, kfaCode: kfaCode ?? null };
  used.drug = drug;
  const missing = (message?: string): DeadLettered =>
    checkStep({ organizationId, mappings: [{ kind: 'drug', localCode: item.drugCode, found: false, message }] }) as DeadLettered;
  if (kfaCode === undefined) return missing();
  const details = await kfaProduct(db, kfa, kfaCode, clock);
  if (details === undefined) return missing(`KFA does not know ${kfaCode}, the code local drug ${item.drugCode} maps to`);
  const product: KfaProduct = { code: details.code, level: details.level, parent92: details.parent92, ingredients: details.ingredients };
  drug.kfa = product;
  const mappings: MappingUse[] = [{ kind: 'drug', localCode: item.drugCode, found: true }];
  const medication = { role: 'prescription' as const, product };
  const wrongLevel = checkStep({ organizationId, mappings, medication });
  if (wrongLevel) return wrongLevel;

  const visit = await completedStep<CreateVisitPins>(db, step.caseId, 'create_visit');
  const requester = await findIhsNumber(fhir, 'Practitioner', data.requester);
  used.requester = requester ?? null;
  if (requester === undefined) return { outcome: 'dead_lettered', reason: 'PRACTITIONER_NOT_FOUND' };

  const unit = details.doseForm ? { unit: details.doseForm.name, system: DOSE_FORM_SYSTEM, code: details.doseForm.code } : {};
  const identifier = { system: prescriptionSystem(organizationId), value: data.prescriptionId };
  const medicationRequest = {
    resourceType: 'MedicationRequest',
    contained: [
      {
        resourceType: 'Medication',
        id: 'medication',
        identifier: [{ system: medicationSystem(organizationId), use: 'official', value: item.itemId }],
        code: { coding: [{ system: KFA_SYSTEM, code: details.code, display: details.display }] },
        status: 'active',
        extension: [
          {
            url: MEDICATION_TYPE_URL,
            valueCodeableConcept: {
              coding: [{ system: 'http://terminology.kemkes.go.id/CodeSystem/medication-type', code: 'NC', display: 'Non-compound' }],
            },
          },
        ],
      },
    ],
    identifier: [
      { ...identifier, use: 'official' },
      { system: prescriptionItemSystem(organizationId), use: 'official', value: item.itemId },
    ],
    status: 'completed',
    intent: 'order',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', code: 'community', display: 'Community' }] }],
    medicationReference: { reference: '#medication', display: details.display },
    subject: { reference: `Patient/${visit.pins.patientIhs}` },
    encounter: { reference: `Encounter/${visit.remote.id}` },
    authoredOn: sourceToPlatformTime(data.authoredAt),
    requester: { reference: `Practitioner/${requester.ihsNumber}` },
    dosageInstruction: [
      {
        sequence: 1,
        text: item.dosage.text,
        timing: { repeat: { frequency: item.dosage.timesPerDay, period: 1, periodUnit: 'd' } },
        route: { coding: [{ system: ROUTE_SYSTEM, code: item.dosage.routeCode }] },
        doseAndRate: [{ doseQuantity: { value: item.dosage.doseAmount, ...unit } }],
      },
    ],
    dispenseRequest: { quantity: { value: item.quantity, ...unit }, performer: { reference: `Organization/${organizationId}` } },
    // Always sent, no contract field (#9).
    substitution: { allowedBoolean: true },
  };
  const invalid = checkStep({ organizationId, mappings, medication, resource: medicationRequest });
  if (invalid) return invalid;

  const result = await searchThenCreate(fhir, 'MedicationRequest', identifier, medicationRequest);
  if (result.outcome !== 'completed') return result;
  const pins: SubmitPrescriptionPins = {
    kfaCode: product.code,
    kfaLevel: product.level,
    parent92: product.parent92,
    ingredients: [...product.ingredients],
    requesterIhs: requester.ihsNumber,
  };
  return { ...result, pins };
};
