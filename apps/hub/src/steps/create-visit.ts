import type { Kysely } from 'kysely';
import type { DeadLetterReason } from '../cases/case-model.js';
import type { CreateVisitPins } from '../cases/pins.js';
import type { Database } from '../db/database.js';
import type { IhsNumberCache } from '../ihs-cache/ihs-number-cache.js';
import { readVisitStarted } from '../ingestion/event-schema.js';
import { findLocation } from '../mapping/location-mappings.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { SatusehatClient } from '../satusehat/client.js';
import { visitEncounterResource } from '../satusehat/resources.js';
import { validateStepPayload } from '../validation/validation.js';
import { lookUpPatient, lookUpPractitioner, personLookupDeps } from './person-lookup.js';
import { AttemptFailed, newAttemptFacts, rejected, type AttemptFacts, type StepOutcome } from './step-outcome.js';

/**
 * One attempt at create visit: resolves the Location from the operator's
 * mapping, the patient and practitioner IHS numbers by NIK or the
 * documented fallbacks (see `person-lookup`) and the organization from the source registration, builds the Encounter and has
 * the Validation module check it, then search-then-create (ADR 0005) under
 * the visit's `encounter/{org}` identifier: one match is adopted, none is
 * created, more than one dead-letters. Any violation dead-letters with the
 * first one in rule order and sends nothing; an unmapped location is found
 * before any request. A completed attempt pins the IHS numbers and the
 * Location ID it sent.
 */
export async function createVisit(
  deps: { db: Kysely<Database>; satusehat: SatusehatClient; ihsCache: IhsNumberCache },
  step: ClaimedStep,
): Promise<StepOutcome> {
  const attempt: AttemptFacts & { valuesUsed: Partial<CreateVisitPins> } = newAttemptFacts();
  try {
    return await attemptCreateVisit(deps, step, attempt);
  } catch (err) {
    throw new AttemptFailed(attempt, { cause: err });
  }
}

/** The attempt itself; `attempt` collects what it resolves and sees as it goes, so a failure can report it. */
async function attemptCreateVisit(
  deps: { db: Kysely<Database>; satusehat: SatusehatClient; ihsCache: IhsNumberCache },
  step: ClaimedStep,
  attempt: AttemptFacts & { valuesUsed: Partial<CreateVisitPins> },
): Promise<StepOutcome> {
  const { db, satusehat, ihsCache } = deps;
  const lookups = personLookupDeps({ satusehat, ihsCache }, step);
  const { envelope } = await db
    .selectFrom('source_event')
    .select('envelope')
    .where('case_id', '=', step.caseId)
    .where('type', '=', 'visit.started')
    .executeTakeFirstOrThrow();
  const visit = readVisitStarted(envelope);
  const deadLettered = (reason: DeadLetterReason): StepOutcome => ({ deadLettered: reason, attempt });

  const location = await findLocation(db, step.sourceSystemId, visit.locationCode);
  if (!location) {
    attempt.violations = validateStepPayload({
      step: 'create_visit',
      organizationId: step.organizationId,
      missingMappings: [{ kind: 'location', localCode: visit.locationCode }],
      encounter: null,
    });
    return rejected(attempt);
  }
  attempt.valuesUsed.locationId = location;

  const patientLookup = await lookUpPatient(lookups, visit.patient, attempt);
  if ('deadLettered' in patientLookup) return deadLettered(patientLookup.deadLettered);
  const patient = patientLookup.found;
  attempt.valuesUsed.patientIhsNumber = patient;

  const practitionerLookup = await lookUpPractitioner(lookups, 'practitioner', visit.practitioner, attempt);
  if ('deadLettered' in practitionerLookup) return deadLettered(practitionerLookup.deadLettered);
  const practitioner = practitionerLookup.found;
  attempt.valuesUsed.practitionerIhsNumber = practitioner;

  const identifier = { organizationId: step.organizationId, visitId: step.visitId };
  const encounter = visitEncounterResource({
    identifier,
    encounterClass: visit.encounterClass,
    patient,
    practitioner,
    location,
    startedAt: visit.startedAt,
  });
  attempt.violations = validateStepPayload({
    step: 'create_visit',
    organizationId: step.organizationId,
    missingMappings: [],
    encounter,
  });
  if (attempt.violations.length > 0) return rejected(attempt);

  const pins = { patientIhsNumber: patient, practitionerIhsNumber: practitioner, locationId: location };
  const existing = await satusehat.findEncounters(identifier);
  // The client resolves a search only on 200 and a create only on 201; any other status throws.
  attempt.httpStatus = 200;
  const [adopted] = existing;
  if (existing.length > 1) return deadLettered('REMOTE_RECORD_AMBIGUOUS');
  if (adopted) return { completed: adopted.remote, pins, attempt };

  const created = await satusehat.createEncounter(encounter);
  attempt.httpStatus = 201;
  return { completed: created, pins, attempt };
}
