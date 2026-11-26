import type { Kysely } from 'kysely';
import type { RemoteId, RemoteIdentifier, StepName } from '../cases/case-model.js';
import { readCreateVisitPins, readSubmitPrescriptionPins, type CreateVisitPins, type SubmitPrescriptionPins } from '../cases/pins.js';
import type { Database } from '../db/database.js';
import type { ClaimedStep } from '../outbox/outbox.js';

/**
 * The Encounter create visit stored and the values it pinned. A later step is
 * claimable only once create visit completed (ADR 0004), so both are there.
 */
export async function readCompletedCreateVisit(
  db: Kysely<Database>,
  step: ClaimedStep,
): Promise<{ encounter: RemoteIdentifier; pins: CreateVisitPins }> {
  const { remote, pins } = await readCompleted(db, step, 'create_visit', 'Encounter');
  return { encounter: remote, pins: readCreateVisitPins(pins) };
}

/**
 * The MedicationRequest submit prescription stored and the values it pinned.
 * The dispense step is claimable only once submit prescription completed
 * (ADR 0004), so both are there.
 */
export async function readCompletedPrescription(
  db: Kysely<Database>,
  step: ClaimedStep,
): Promise<{ medicationRequest: RemoteIdentifier; pins: SubmitPrescriptionPins }> {
  const { remote, pins } = await readCompleted(db, step, 'submit_prescription', 'MedicationRequest');
  return { medicationRequest: remote, pins: readSubmitPrescriptionPins(pins) };
}

async function readCompleted(db: Kysely<Database>, step: ClaimedStep, name: StepName, type: RemoteIdentifier['type']) {
  const row = await db
    .selectFrom('step')
    .select(['state', 'remote_type', 'remote_id', 'remote_version', 'pins'])
    .where('case_id', '=', step.caseId)
    .where('name', '=', name)
    .executeTakeFirstOrThrow();
  if (row.state !== 'completed' || row.remote_type !== type || row.remote_id === null) {
    throw new Error(`invariant broken: ${step.name} of case ${step.caseId} runs, but ${name} is ${row.state} with no ${type}`);
  }
  const remote: RemoteIdentifier = {
    type,
    // Stored only by the step's lease-fenced completion, from the record SATUSEHAT returned.
    id: row.remote_id as RemoteId,
    version: row.remote_version,
  };
  return { remote, pins: row.pins };
}
