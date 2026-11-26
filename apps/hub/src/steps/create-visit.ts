import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import { readVisitStarted } from '../ingestion/event-schema.js';
import { findLocation } from '../mapping/location-mappings.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { SatusehatClient } from '../satusehat/client.js';
import type { StepOutcome } from './step-outcome.js';

/**
 * One attempt at create visit: resolves the patient and practitioner IHS
 * numbers by NIK, the Location from the operator's mapping and the
 * organization from the source registration, then search-then-create (ADR
 * 0005) under the visit's `encounter/{org}` identifier: one match is adopted,
 * none is created, more than one dead-letters. An unmapped location
 * dead-letters before any request is sent. Person lookups other than by NIK
 * land with #32.
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

  const patients = visit.patient.nik === undefined ? [] : await satusehat.findPatientsByNik(visit.patient.nik);
  const [patient] = patients;
  if (!patient || patients.length > 1) return { deadLettered: 'PATIENT_NOT_FOUND' };

  const practitioners =
    visit.practitioner.nik === undefined ? [] : await satusehat.findPractitionersByNik(visit.practitioner.nik);
  const [practitioner] = practitioners;
  if (!practitioner || practitioners.length > 1) return { deadLettered: 'PRACTITIONER_NOT_FOUND' };

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
