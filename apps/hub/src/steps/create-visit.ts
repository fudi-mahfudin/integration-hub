import type { Kysely } from 'kysely';
import type { DeadLetterReason } from '../cases/case-model.js';
import type { Database } from '../db/database.js';
import { readVisitStarted } from '../ingestion/event-schema.js';
import { findLocation } from '../mapping/location-mappings.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { IhsNumber, SatusehatClient } from '../satusehat/client.js';
import { visitEncounterResource } from '../satusehat/resources.js';
import { validateStepPayload } from '../validation/validation.js';
import { AttemptFailed, type AttemptFacts, type StepOutcome } from './step-outcome.js';

/**
 * One attempt at create visit: resolves the Location from the operator's
 * mapping, the patient and practitioner IHS numbers by NIK and the
 * organization from the source registration, builds the Encounter and has
 * the Validation module check it, then search-then-create (ADR 0005) under
 * the visit's `encounter/{org}` identifier: one match is adopted, none is
 * created, more than one dead-letters. Any violation dead-letters with the
 * first one in rule order and sends nothing; an unmapped location is found
 * before any request. A completed attempt pins the IHS numbers and the
 * Location ID it sent.
 */
export async function createVisit(
  deps: { db: Kysely<Database>; satusehat: SatusehatClient },
  step: ClaimedStep,
): Promise<StepOutcome> {
  const attempt: AttemptFacts = { httpStatus: null, valuesUsed: {}, lookupMethods: {}, violations: [] };
  try {
    return await attemptCreateVisit(deps, step, attempt);
  } catch (err) {
    throw new AttemptFailed(attempt, { cause: err });
  }
}

/** The attempt itself; `attempt` collects what it resolves and sees as it goes, so a failure can report it. */
async function attemptCreateVisit(
  deps: { db: Kysely<Database>; satusehat: SatusehatClient },
  step: ClaimedStep,
  attempt: AttemptFacts,
): Promise<StepOutcome> {
  const { db, satusehat } = deps;
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

  const patient = await lookUpByNik('patient', visit.patient.nik, (nik) => satusehat.findPatientsByNik(nik), attempt);
  if (!patient) return deadLettered('PATIENT_NOT_FOUND');
  attempt.valuesUsed.patientIhsNumber = patient;
  attempt.lookupMethods.patient = 'nik';

  const practitioner = await lookUpByNik(
    'practitioner',
    visit.practitioner.nik,
    (nik) => satusehat.findPractitionersByNik(nik),
    attempt,
  );
  if (!practitioner) return deadLettered('PRACTITIONER_NOT_FOUND');
  attempt.valuesUsed.practitionerIhsNumber = practitioner;
  attempt.lookupMethods.practitioner = 'nik';

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
  if (adopted) return { completed: adopted, pins, attempt };

  const created = await satusehat.createEncounter(encounter);
  attempt.httpStatus = 201;
  return { completed: created, pins, attempt };
}

/** Dead-letters a payload the Validation module rejected, with its first violation in rule order. */
function rejected(attempt: AttemptFacts): StepOutcome {
  const [first] = attempt.violations;
  if (!first) throw new Error('rejected() needs at least one violation');
  return { deadLettered: first.code, attempt };
}

/**
 * A person the hub cannot resolve by NIK alone: the event names them without
 * a NIK, or more than one record has it. The fallback lookups and their
 * ambiguity rules land with #32; until then the attempt fails without an
 * outcome, so the step is not dead-lettered under a wrong reason.
 */
export class PersonLookupUnresolved extends Error {
  constructor(
    readonly person: 'patient' | 'practitioner',
    readonly matches: number | null,
  ) {
    super(
      matches === null
        ? `the ${person} has no NIK; lookups other than by NIK are not supported yet (#32)`
        : `${matches} ${person}s share the NIK; an ambiguous lookup is not supported yet (#32)`,
    );
    this.name = 'PersonLookupUnresolved';
  }
}

/** The one IHS number found for `nik`, or `undefined` when no one has it; notes the search's status on the attempt. */
async function lookUpByNik(
  person: 'patient' | 'practitioner',
  nik: string | undefined,
  find: (nik: string) => Promise<IhsNumber[]>,
  attempt: AttemptFacts,
): Promise<IhsNumber | undefined> {
  if (nik === undefined) throw new PersonLookupUnresolved(person, null);
  const found = await find(nik);
  // The client resolves only on the 200 it expects.
  attempt.httpStatus = 200;
  if (found.length > 1) throw new PersonLookupUnresolved(person, found.length);
  return found[0];
}
