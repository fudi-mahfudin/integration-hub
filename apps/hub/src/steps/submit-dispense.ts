import { findIhsNumber, type SourcePerson } from '../lookup/people.js';
import { kfaProduct } from '../mapping/kfa-products.js';
import { findKfaCode } from '../mapping/mappings.js';
import { sourceToPlatformTime } from '../time.js';
import { SUBSTITUTION_REASONS, SUBSTITUTION_TYPE_SYSTEM } from '../validation/medication-dispense-rules.js';
import { KFA_SYSTEM, MEDICATION_TYPE_URL } from '../validation/medication-request-rules.js';
import { substitutionKind, type KfaProduct, type MappingUse, type MedicationUse } from '../validation/validation.js';
import type { CreateVisitPins } from './create-visit.js';
import { checkStep, completedStep, searchThenCreate, sourceEvent, type DeadLettered, type StepRunner } from './step-runner.js';
import { prescriptionSystem, type SubmitPrescriptionPins } from './submit-prescription.js';

const prescriptionItemSystem = (organizationId: string) => `http://sys-ids.kemkes.go.id/prescription-item/${organizationId}`;
const medicationSystem = (organizationId: string) => `http://sys-ids.kemkes.go.id/medication/${organizationId}`;
const DOSE_FORM_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-orderableDrugForm';

/** What submit dispense pins on completion (#10): the dispensed KFA product and the pharmacist. */
export interface SubmitDispensePins {
  [pin: string]: unknown;
  kfaCode: string;
  kfaLevel: number;
  parent92: string | null;
  /** The dispensed product's 91 set, sorted. */
  ingredients: string[];
  pharmacistIhs: string;
  wasSubstituted: boolean;
}

interface DrugDispensed {
  prescriptionId: string;
  itemId: string;
  drugCode: string;
  quantity: number;
  preparedAt: string;
  handedOverAt: string;
  pharmacist: SourcePerson;
  batch?: { lot: string; expiry: string };
  substitution?: { reasonCode: string };
}

/**
 * Submit dispense: `drug.dispensed` → MedicationDispense. Maps the local
 * drug code to KFA, takes its details, and decides against the product the
 * prescription step pinned (never the live mapping) whether this is a
 * substitution; the KFA level, a therapeutic substitution and a mismatch
 * with the source's declaration dead-letter before any platform call. Then
 * looks up the pharmacist, builds the MedicationDispense authorised by the
 * case's MedicationRequest, validates it and searches it by
 * `prescription/{org}`, creating it only if absent.
 */
export const submitDispense: StepRunner = async (step, { db, fhir, kfa, clock }, { used }) => {
  const data = (await sourceEvent(db, step.caseId, 'drug.dispensed')).data as DrugDispensed;
  const organizationId = step.organizationId;

  const kfaCode = await findKfaCode(db, step.sourceId, data.drugCode);
  const drug: Record<string, unknown> = { localCode: data.drugCode, kfaCode: kfaCode ?? null };
  used.drug = drug;
  const missing = (message?: string): DeadLettered =>
    checkStep({ organizationId, mappings: [{ kind: 'drug', localCode: data.drugCode, found: false, message }] }) as DeadLettered;
  if (kfaCode === undefined) return missing();
  const details = await kfaProduct(db, kfa, kfaCode, clock);
  if (details === undefined) return missing(`KFA does not know ${kfaCode}, the code local drug ${data.drugCode} maps to`);
  const product: KfaProduct = { code: details.code, level: details.level, parent92: details.parent92, ingredients: details.ingredients };
  drug.kfa = product;

  const prescription = await completedStep<SubmitPrescriptionPins>(db, step.caseId, 'submit_prescription');
  const p = prescription.pins;
  const prescribed: KfaProduct = { code: p.kfaCode, level: p.kfaLevel, parent92: p.parent92, ingredients: p.ingredients };
  const mappings: MappingUse[] = [{ kind: 'drug', localCode: data.drugCode, found: true }];
  const medication: MedicationUse = { role: 'dispense', product, prescribed, declaredSubstitution: data.substitution !== undefined };
  const refused = checkStep({ organizationId, mappings, medication });
  if (refused) return refused;
  const wasSubstituted = substitutionKind(product, prescribed) === 'substitution';

  const visit = await completedStep<CreateVisitPins>(db, step.caseId, 'create_visit');
  const pharmacist = await findIhsNumber(fhir, 'Practitioner', data.pharmacist);
  used.pharmacist = pharmacist ?? null;
  if (pharmacist === undefined) return { outcome: 'dead_lettered', reason: 'PRACTITIONER_NOT_FOUND' };

  const reason = data.substitution ? SUBSTITUTION_REASONS[data.substitution.reasonCode] : undefined;
  const substitution =
    wasSubstituted && reason
      ? {
          wasSubstituted: true,
          type: { coding: [{ system: SUBSTITUTION_TYPE_SYSTEM, code: 'G', display: 'generic composition' }] },
          reason: [{ coding: [reason] }],
          responsibleParty: [{ reference: `Practitioner/${p.requesterIhs}` }, { reference: `Practitioner/${pharmacist.ihsNumber}` }],
        }
      : { wasSubstituted: false };
  const unit = details.doseForm ? { unit: details.doseForm.name, system: DOSE_FORM_SYSTEM, code: details.doseForm.code } : {};
  const identifier = { system: prescriptionSystem(organizationId), value: data.prescriptionId };
  const medicationDispense = {
    resourceType: 'MedicationDispense',
    contained: [
      {
        resourceType: 'Medication',
        id: 'medication',
        identifier: [{ system: medicationSystem(organizationId), use: 'official', value: data.itemId }],
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
        // The expiry stays a plain date (#9).
        ...(data.batch ? { batch: { lotNumber: data.batch.lot, expirationDate: data.batch.expiry } } : {}),
      },
    ],
    identifier: [
      { ...identifier, use: 'official' },
      { system: prescriptionItemSystem(organizationId), use: 'official', value: data.itemId },
    ],
    status: 'completed',
    category: {
      coding: [{ system: 'http://terminology.hl7.org/fhir/CodeSystem/medicationdispense-category', code: 'community', display: 'Community' }],
    },
    medicationReference: { reference: '#medication', display: details.display },
    subject: { reference: `Patient/${visit.pins.patientIhs}` },
    context: { reference: `Encounter/${visit.remote.id}` },
    performer: [{ actor: { reference: `Practitioner/${pharmacist.ihsNumber}` } }],
    authorizingPrescription: [{ reference: `MedicationRequest/${prescription.remote.id}` }],
    quantity: { value: data.quantity, ...unit },
    whenPrepared: sourceToPlatformTime(data.preparedAt),
    whenHandedOver: sourceToPlatformTime(data.handedOverAt),
    substitution,
  };
  const invalid = checkStep({ organizationId, mappings, medication, resource: medicationDispense });
  if (invalid) return invalid;

  const result = await searchThenCreate(fhir, 'MedicationDispense', identifier, medicationDispense);
  if (result.outcome !== 'completed') return result;
  const pins: SubmitDispensePins = {
    kfaCode: product.code,
    kfaLevel: product.level,
    parent92: product.parent92,
    ingredients: [...product.ingredients],
    pharmacistIhs: pharmacist.ihsNumber,
    wasSubstituted,
  };
  return { ...result, pins };
};
