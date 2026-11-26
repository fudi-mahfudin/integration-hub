import type { Kysely } from 'kysely';
import type { DeadLetterReason, RemoteId, RemoteIdentifier } from '../cases/case-model.js';
import { kfaProductPins, readCreateVisitPins, type SubmitPrescriptionPins } from '../cases/pins.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { readPrescriptionWritten } from '../ingestion/event-schema.js';
import type { KfaClient } from '../kfa/kfa-client.js';
import { resolveKfaDetails } from '../kfa/kfa-products.js';
import { findKfaCode } from '../mapping/drug-mappings.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { SatusehatClient } from '../satusehat/client.js';
import { prescriptionMedicationRequestResource } from '../satusehat/resources.js';
import { validateStepPayload, type MissingMapping } from '../validation/validation.js';
import { lookUpByNik } from './person-lookup.js';
import { AttemptFailed, rejected, type AttemptFacts, type StepOutcome } from './step-outcome.js';

/** What submit prescription reads and calls. */
export interface SubmitPrescriptionDeps {
  db: Kysely<Database>;
  satusehat: SatusehatClient;
  kfa: KfaClient;
  clock: Clock;
}

type PrescriptionAttempt = AttemptFacts & { valuesUsed: Partial<SubmitPrescriptionPins> };

/**
 * One attempt at submit prescription: maps the item's local drug code to a
 * KFA code by the operator's mapping and resolves its KFA details (stored,
 * else fetched from KFA v2 once), looks the requester up by NIK, builds the
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
  const attempt: PrescriptionAttempt = { httpStatus: null, valuesUsed: {}, lookupMethods: {}, violations: [] };
  try {
    return await attemptSubmitPrescription(deps, step, attempt);
  } catch (err) {
    throw new AttemptFailed(attempt, { cause: err });
  }
}

async function attemptSubmitPrescription(deps: SubmitPrescriptionDeps, step: ClaimedStep, attempt: PrescriptionAttempt): Promise<StepOutcome> {
  const { db, satusehat, kfa, clock } = deps;
  const { envelope } = await db
    .selectFrom('source_event')
    .select('envelope')
    .where('case_id', '=', step.caseId)
    .where('type', '=', 'prescription.written')
    .executeTakeFirstOrThrow();
  const prescription = readPrescriptionWritten(envelope);
  const visit = await readCompletedCreateVisit(db, step);
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

  const resolved = await resolveKfaDetails({ db, kfa }, kfaCode, clock());
  if (resolved.httpStatus !== null) attempt.httpStatus = resolved.httpStatus;
  const medication = resolved.details;
  if (!medication) return mappingMissing({ kind: 'kfa', localCode: drugCode, kfaCode });
  const { product } = medication;
  Object.assign(attempt.valuesUsed, kfaProductPins(product));

  const requester = await lookUpByNik('requester', prescription.requester.nik, (nik) => satusehat.findPractitionersByNik(nik), attempt);
  if (!requester) return deadLettered('PRACTITIONER_NOT_FOUND');
  attempt.valuesUsed.requesterIhsNumber = requester;
  attempt.lookupMethods.requester = 'nik';

  const identifier = { organizationId: step.organizationId, prescriptionId: prescription.prescriptionId };
  const medicationRequest = prescriptionMedicationRequestResource({
    identifier,
    itemId: prescription.item.itemId,
    encounter: visit.encounter,
    patient: visit.patientIhsNumber,
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

/**
 * The Encounter create visit stored and the patient it pinned. The step is
 * claimable only once create visit completed (ADR 0004), so both are there.
 */
async function readCompletedCreateVisit(db: Kysely<Database>, step: ClaimedStep) {
  const row = await db
    .selectFrom('step')
    .select(['state', 'remote_type', 'remote_id', 'remote_version', 'pins'])
    .where('case_id', '=', step.caseId)
    .where('name', '=', 'create_visit')
    .executeTakeFirstOrThrow();
  if (row.state !== 'completed' || row.remote_type !== 'Encounter' || row.remote_id === null) {
    throw new Error(`invariant broken: submit prescription of case ${step.caseId} runs, but create visit is ${row.state} with no Encounter`);
  }
  const encounter: RemoteIdentifier = {
    type: 'Encounter',
    // Stored only by create visit's lease-fenced completion, from the Encounter SATUSEHAT returned.
    id: row.remote_id as RemoteId,
    version: row.remote_version,
  };
  return { encounter, patientIhsNumber: readCreateVisitPins(row.pins).patientIhsNumber };
}
