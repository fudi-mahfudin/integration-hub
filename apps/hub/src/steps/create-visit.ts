import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import { readVisitStarted } from '../ingestion/event-schema.js';
import { findLocation } from '../mapping/location-mappings.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { IhsNumber, SatusehatClient } from '../satusehat/client.js';
import type { StepOutcome } from './step-outcome.js';

/**
 * One attempt at create visit: resolves the patient and practitioner IHS
 * numbers by NIK, the Location from the operator's mapping and the
 * organization from the source registration, then search-then-create (ADR
 * 0005) under the visit's `encounter/{org}` identifier: one match is adopted,
 * none is created, more than one dead-letters. An unmapped location
 * dead-letters before any request is sent; a person no one has by NIK
 * dead-letters as not found.
 */
export async function createVisit(
  deps: { db: Kysely<Database>; satusehat: SatusehatClient },
  step: ClaimedStep,
): Promise<StepOutcome> {
  const { db, satusehat } = deps;
  const { envelope } = await db
    .selectFrom('source_event')
    .select('envelope')
    .where('case_id', '=', step.caseId)
    .where('type', '=', 'visit.started')
    .executeTakeFirstOrThrow();
  const visit = readVisitStarted(envelope);

  const location = await findLocation(db, step.sourceSystemId, visit.locationCode);
  if (!location) return { deadLettered: 'MAPPING_MISSING' };

  const patient = await lookUpByNik('patient', visit.patient.nik, (nik) => satusehat.findPatientsByNik(nik));
  if (!patient) return { deadLettered: 'PATIENT_NOT_FOUND' };
  const practitioner = await lookUpByNik('practitioner', visit.practitioner.nik, (nik) =>
    satusehat.findPractitionersByNik(nik),
  );
  if (!practitioner) return { deadLettered: 'PRACTITIONER_NOT_FOUND' };

  const identifier = { organizationId: step.organizationId, visitId: step.visitId };
  const existing = await satusehat.findEncounters(identifier);
  const [adopted] = existing;
  if (existing.length > 1) return { deadLettered: 'REMOTE_RECORD_AMBIGUOUS' };
  if (adopted) return { completed: adopted };

  const created = await satusehat.createEncounter({
    identifier,
    encounterClass: visit.encounterClass,
    patient,
    practitioner,
    location,
    startedAt: visit.startedAt,
  });
  return { completed: created };
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

/** The one IHS number found for `nik`, or `undefined` when no one has it. */
async function lookUpByNik(
  person: 'patient' | 'practitioner',
  nik: string | undefined,
  find: (nik: string) => Promise<IhsNumber[]>,
): Promise<IhsNumber | undefined> {
  if (nik === undefined) throw new PersonLookupUnresolved(person, null);
  const found = await find(nik);
  if (found.length > 1) throw new PersonLookupUnresolved(person, found.length);
  return found[0];
}
