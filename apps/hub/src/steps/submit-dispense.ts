import type { Kysely } from 'kysely';
import type { DeadLetterReason } from '../cases/case-model.js';
import { kfaProductOf, kfaProductPins, type SubmitDispensePins } from '../cases/pins.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { readDrugDispensed } from '../ingestion/event-schema.js';
import type { KfaClient } from '../kfa/kfa-client.js';
import { judgeDispense } from '../kfa/kfa-product.js';
import { resolveKfaDetails } from '../kfa/kfa-products.js';
import { findKfaCode } from '../mapping/drug-mappings.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { SatusehatClient } from '../satusehat/client.js';
import { dispenseMedicationDispenseResource } from '../satusehat/resources.js';
import { validateStepPayload, type MissingMapping } from '../validation/validation.js';
import { readCompletedCreateVisit, readCompletedPrescription } from './completed-steps.js';
import { lookUpPractitioner } from './person-lookup.js';
import { AttemptFailed, rejected, type AttemptFacts, type StepOutcome } from './step-outcome.js';

/** What submit dispense reads and calls. */
export interface SubmitDispenseDeps {
  db: Kysely<Database>;
  satusehat: SatusehatClient;
  kfa: KfaClient;
  clock: Clock;
}

type DispenseAttempt = AttemptFacts & { valuesUsed: Partial<SubmitDispensePins> };

/**
 * One attempt at submit dispense: maps the dispensed local drug code to a KFA
 * code and resolves its KFA details as submit prescription does, judges the
 * dispensed product against the product submit prescription pinned (#9) and
 * sets `wasSubstituted` from that judgement, looks the pharmacist up (see `person-lookup`),
 * builds the MedicationDispense authorized by the stored MedicationRequest on
 * the stored Encounter, and has the Validation module check it, the source's
 * substitution declaration included; then search-then-create (ADR 0005)
 * under the prescription's `prescription/{org}` identifier, which a dispense
 * reuses. A completed attempt pins the dispensed KFA product and the
 * pharmacist's IHS number.
 */
export async function submitDispense(deps: SubmitDispenseDeps, step: ClaimedStep): Promise<StepOutcome> {
  const attempt: DispenseAttempt = { httpStatus: null, valuesUsed: {}, lookupMethods: {}, violations: [] };
  try {
    return await attemptSubmitDispense(deps, step, attempt);
  } catch (err) {
    throw new AttemptFailed(attempt, { cause: err });
  }
}

async function attemptSubmitDispense(deps: SubmitDispenseDeps, step: ClaimedStep, attempt: DispenseAttempt): Promise<StepOutcome> {
  const { db, satusehat, kfa, clock } = deps;
  const { envelope } = await db
    .selectFrom('source_event')
    .select('envelope')
    .where('case_id', '=', step.caseId)
    .where('type', '=', 'drug.dispensed')
    .executeTakeFirstOrThrow();
  const dispensed = readDrugDispensed(envelope);
  const visit = await readCompletedCreateVisit(db, step);
  const prescription = await readCompletedPrescription(db, step);
  const { pins: prescribedPins } = prescription;
  const prescribed = kfaProductOf(prescribedPins);
  const declaredSubstitution = dispensed.substitution !== null;
  const deadLettered = (reason: DeadLetterReason): StepOutcome => ({ deadLettered: reason, attempt });
  const mappingMissing = (mapping: MissingMapping): StepOutcome => {
    attempt.violations = validateStepPayload({
      step: 'submit_dispense',
      organizationId: step.organizationId,
      missingMappings: [mapping],
      prescribed,
      dispensed: null,
      declaredSubstitution,
      medicationDispense: null,
    });
    return rejected(attempt);
  };

  const { drugCode } = dispensed;
  const kfaCode = await findKfaCode(db, step.sourceSystemId, drugCode);
  if (!kfaCode) return mappingMissing({ kind: 'drug', localCode: drugCode });
  attempt.valuesUsed.kfaCode = kfaCode;

  const resolved = await resolveKfaDetails({ db, kfa }, kfaCode, clock());
  if (resolved.httpStatus !== null) attempt.httpStatus = resolved.httpStatus;
  const medication = resolved.details;
  if (!medication) return mappingMissing({ kind: 'kfa', localCode: drugCode, kfaCode });
  const { product } = medication;
  Object.assign(attempt.valuesUsed, kfaProductPins(product));

  const pharmacistLookup = await lookUpPractitioner(satusehat, 'pharmacist', dispensed.pharmacist, attempt);
  if ('deadLettered' in pharmacistLookup) return deadLettered(pharmacistLookup.deadLettered);
  const pharmacist = pharmacistLookup.found;
  attempt.valuesUsed.pharmacistIhsNumber = pharmacist;

  // The hub's decision, from KFA; the Validation module checks the source's declaration against it.
  const substituted = judgeDispense(prescribed, product) !== 'as_prescribed';
  const identifier = { organizationId: step.organizationId, prescriptionId: dispensed.prescriptionId };
  const medicationDispense = dispenseMedicationDispenseResource({
    identifier,
    itemId: dispensed.itemId,
    encounter: visit.encounter,
    medicationRequest: prescription.medicationRequest,
    patient: visit.pins.patientIhsNumber,
    pharmacist,
    medication,
    quantity: dispensed.quantity,
    preparedAt: dispensed.preparedAt,
    handedOverAt: dispensed.handedOverAt,
    batch: dispensed.batch,
    substitution: substituted
      ? { reasonCode: dispensed.substitution?.reasonCode ?? null, requester: prescribedPins.requesterIhsNumber }
      : null,
  });
  attempt.violations = validateStepPayload({
    step: 'submit_dispense',
    organizationId: step.organizationId,
    missingMappings: [],
    prescribed,
    dispensed: product,
    declaredSubstitution,
    medicationDispense,
  });
  if (attempt.violations.length > 0) return rejected(attempt);

  const pins: SubmitDispensePins = { ...kfaProductPins(product), pharmacistIhsNumber: pharmacist };
  const existing = await satusehat.findMedicationDispenses(identifier);
  // The client resolves a search only on 200 and a create only on 201; any other status throws.
  attempt.httpStatus = 200;
  const [adopted] = existing;
  if (existing.length > 1) return deadLettered('REMOTE_RECORD_AMBIGUOUS');
  if (adopted) return { completed: adopted, pins, attempt };

  const created = await satusehat.createMedicationDispense(medicationDispense);
  attempt.httpStatus = 201;
  return { completed: created, pins, attempt };
}
