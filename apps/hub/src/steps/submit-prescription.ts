import type { Kysely } from 'kysely';
import type { DeadLetterReason } from '../cases/case-model.js';
import { kfaProductPins, type SubmitPrescriptionPins } from '../cases/pins.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { readPrescriptionWritten } from '../ingestion/event-schema.js';
import type { IhsNumberCache } from '../ihs-cache/ihs-number-cache.js';
import type { KfaClient } from '../kfa/kfa-client.js';
import { resolveKfaDetails } from '../kfa/kfa-products.js';
import { findKfaCode } from '../mapping/drug-mappings.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { SatusehatClient } from '../satusehat/client.js';
import { prescriptionMedicationRequestResource } from '../satusehat/resources.js';
import { validateStepPayload, type MissingMapping } from '../validation/validation.js';
import { readCompletedCreateVisit } from './completed-steps.js';
import { lookUpPractitioner, personLookupDeps } from './person-lookup.js';
import { AttemptFailed, newAttemptFacts, rejected, type AttemptFacts, type StepOutcome } from './step-outcome.js';

/** What submit prescription reads and calls. */
export interface SubmitPrescriptionDeps {
  db: Kysely<Database>;
  satusehat: SatusehatClient;
  kfa: KfaClient;
  clock: Clock;
  /** The IHS-number cache in front of the NIK search (#47). */
  ihsCache: IhsNumberCache;
}

type PrescriptionAttempt = AttemptFacts & { valuesUsed: Partial<SubmitPrescriptionPins> };

/**
 * One attempt at submit prescription: maps the item's local drug code to a
 * KFA code by the operator's mapping and resolves its KFA details (stored,
 * else fetched from KFA v2 once), looks the requester up (see `person-lookup`), builds the
 * MedicationRequest on the Encounter and patient create visit stored and
 * pinned, and has the Validation module check it; then search-then-create
 * (ADR 0005) under the `prescription/{org}` identifier: one match is
 * adopted, none is created, more than one dead-letters. A missing mapping,
 * or a code KFA does not know, is `MAPPING_MISSING` and found before any
 * FHIR request. A KFA lookup that fails (timeout, 5xx) ends the attempt
 * without an outcome. A completed attempt pins the KFA product and the
 * requester's IHS number.
 */
export async function submitPrescription(deps: SubmitPrescriptionDeps, step: ClaimedStep): Promise<StepOutcome> {
  const attempt: PrescriptionAttempt = newAttemptFacts();
  try {
    return await attemptSubmitPrescription(deps, step, attempt);
  } catch (err) {
    throw new AttemptFailed(attempt, { cause: err });
  }
}

async function attemptSubmitPrescription(deps: SubmitPrescriptionDeps, step: ClaimedStep, attempt: PrescriptionAttempt): Promise<StepOutcome> {
  const { db, satusehat, kfa, clock, ihsCache } = deps;
  const lookups = personLookupDeps({ satusehat, ihsCache }, step);
  const { envelope } = await db
    .selectFrom('source_event')
    .select('envelope')
    .where('case_id', '=', step.caseId)
    .where('type', '=', 'prescription.written')
    .executeTakeFirstOrThrow();
  const prescription = readPrescriptionWritten(envelope);
  const visit = await readCompletedCreateVisit(db, step);
  const patient = visit.pins.patientIhsNumber;
  const deadLettered = (reason: DeadLetterReason): StepOutcome => ({ deadLettered: reason, attempt });
  const mappingMissing = (mapping: MissingMapping): StepOutcome => {
    attempt.violations = validateStepPayload({
      step: 'submit_prescription',
      organizationId: step.organizationId,
      missingMappings: [mapping],
      product: null,
      medicationRequest: null,
    });
    return rejected(attempt);
  };

  const { drugCode } = prescription.item;
  const kfaCode = await findKfaCode(db, step.sourceSystemId, drugCode);
  if (!kfaCode) return mappingMissing({ kind: 'drug', localCode: drugCode });
  attempt.valuesUsed.kfaCode = kfaCode;

  const resolved = await resolveKfaDetails({ db, kfa }, kfaCode, clock(), step.replayedAt);
  if (resolved.httpStatus !== null) attempt.httpStatus = resolved.httpStatus;
  const medication = resolved.details;
  if (!medication) return mappingMissing({ kind: 'kfa', localCode: drugCode, kfaCode });
  const { product } = medication;
  Object.assign(attempt.valuesUsed, kfaProductPins(product));

  const requesterLookup = await lookUpPractitioner(lookups, 'requester', prescription.requester, attempt);
  if ('deadLettered' in requesterLookup) return deadLettered(requesterLookup.deadLettered);
  const requester = requesterLookup.found;
  attempt.valuesUsed.requesterIhsNumber = requester;

  const identifier = { organizationId: step.organizationId, prescriptionId: prescription.prescriptionId };
  const medicationRequest = prescriptionMedicationRequestResource({
    identifier,
    itemId: prescription.item.itemId,
    encounter: visit.encounter,
    patient,
    requester,
    authoredAt: prescription.authoredAt,
    medication,
    quantity: prescription.item.quantity,
    dosage: prescription.item.dosage,
  });
  attempt.violations = validateStepPayload({
    step: 'submit_prescription',
    organizationId: step.organizationId,
    missingMappings: [],
    product,
    medicationRequest,
  });
  if (attempt.violations.length > 0) return rejected(attempt);

  const pins: SubmitPrescriptionPins = { ...kfaProductPins(product), requesterIhsNumber: requester };
  const existing = await satusehat.findMedicationRequests(identifier);
  // The client resolves a search only on 200 and a create only on 201; any other status throws.
  attempt.httpStatus = 200;
  const [adopted] = existing;
  if (existing.length > 1) return deadLettered('REMOTE_RECORD_AMBIGUOUS');
  if (adopted) return { completed: adopted, pins, attempt };

  const created = await satusehat.createMedicationRequest(medicationRequest);
  attempt.httpStatus = 201;
  return { completed: created, pins, attempt };
}
