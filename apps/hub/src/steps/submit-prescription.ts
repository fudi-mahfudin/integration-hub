import { findIhsNumber, type SourcePerson } from '../lookup/people.js';
import { sourceToPlatformTime } from '../time.js';
import type { KfaProduct } from '../validation/validation.js';
import type { CreateVisitPins } from './create-visit.js';
import { containedMedication, doseFormUnit, prescriptionIdentifiers, resolveDrug } from './medication.js';
import { checkStep, completedStep, searchThenCreate, sourceEvent, type StepRunner } from './step-runner.js';

const ROUTE_SYSTEM = 'http://www.whocc.no/atc';

/** What submit prescription pins on completion (#10); submit dispense compares against these, never the live mapping. */
export interface SubmitPrescriptionPins {
  [pin: string]: unknown;
  /** The prescribed product (its 91 set sorted). */
  product: KfaProduct;
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
export const submitPrescription: StepRunner = async (step, deps, attempt) => {
  const { db, fhir } = deps;
  const { used } = attempt;
  const data = (await sourceEvent(db, step.caseId, 'prescription.written')).data as PrescriptionWritten;
  const item = data.items[0];
  const organizationId = step.organizationId;

  // Local data and KFA first, so a missing mapping or a wrong level never reaches FHIR.
  const drug = await resolveDrug(deps, step, item.drugCode, attempt);
  if ('outcome' in drug) return drug;
  const { details, product, mappings } = drug;
  const medication = { role: 'prescription' as const, product };
  const wrongLevel = checkStep({ organizationId, mappings, medication });
  if (wrongLevel) return wrongLevel;

  const visit = await completedStep<CreateVisitPins>(db, step.caseId, 'create_visit');
  const requester = await findIhsNumber(fhir, 'Practitioner', data.requester);
  used.requester = requester ?? null;
  if (requester === undefined) return { outcome: 'dead_lettered', reason: 'PRACTITIONER_NOT_FOUND' };

  const unit = doseFormUnit(details);
  const { identifier, identifiers } = prescriptionIdentifiers(organizationId, data.prescriptionId, item.itemId);
  const medicationRequest = {
    resourceType: 'MedicationRequest',
    contained: [containedMedication(details, organizationId, item.itemId)],
    identifier: identifiers,
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
  const pins: SubmitPrescriptionPins = { product, requesterIhs: requester.ihsNumber };
  return { ...result, pins };
};
