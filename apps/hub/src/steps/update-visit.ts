import type { Kysely } from 'kysely';
import type { UpdateVisitPins } from '../cases/pins.js';
import type { Database } from '../db/database.js';
import { readVisitFinished, readVisitStarted } from '../ingestion/event-schema.js';
import type { ClaimedStep } from '../outbox/outbox.js';
import type { SatusehatClient } from '../satusehat/client.js';
import { platformTime } from '../satusehat/platform-time.js';
import { finishedEncounterResource } from '../satusehat/resources.js';
import { validateStepPayload } from '../validation/validation.js';
import { readCompletedCreateVisit } from './completed-steps.js';
import { AttemptFailed, rejected, type AttemptFacts, type StepOutcome } from './step-outcome.js';

/** What update visit reads and calls. */
export interface UpdateVisitDeps {
  db: Kysely<Database>;
  satusehat: SatusehatClient;
}

type UpdateVisitAttempt = AttemptFacts & { valuesUsed: Partial<UpdateVisitPins> };

/**
 * One attempt at update visit: rebuilds the Encounter create visit stored
 * from the values it pinned and the recorded `visit.started`, now `finished`
 * at the recorded `finishedAt`, and has the Validation module check it. Then
 * search-then-update, as search-then-create does for the other steps (ADR
 * 0005): the visit's `encounter/{org}` identifier must find exactly the
 * stored Encounter; if it is already `finished` at this end, a previous
 * attempt's PUT landed and is adopted, otherwise the Encounter is PUT.
 * Either way the step stores the Encounter's new `meta.versionId` and pins
 * the values it re-sent.
 */
export async function updateVisit(deps: UpdateVisitDeps, step: ClaimedStep): Promise<StepOutcome> {
  const attempt: UpdateVisitAttempt = { httpStatus: null, valuesUsed: {}, lookupMethods: {}, violations: [] };
  try {
    return await attemptUpdateVisit(deps, step, attempt);
  } catch (err) {
    throw new AttemptFailed(attempt, { cause: err });
  }
}

async function attemptUpdateVisit(deps: UpdateVisitDeps, step: ClaimedStep, attempt: UpdateVisitAttempt): Promise<StepOutcome> {
  const { db, satusehat } = deps;
  const envelopes = await db
    .selectFrom('source_event')
    .select(['type', 'envelope'])
    .where('case_id', '=', step.caseId)
    .where('type', 'in', ['visit.started', 'visit.finished'])
    .execute();
  const envelopeOf = (type: 'visit.started' | 'visit.finished') => {
    const row = envelopes.find((e) => e.type === type);
    if (!row) throw new Error(`invariant broken: update_visit of case ${step.caseId} runs without a recorded ${type}`);
    return row.envelope;
  };
  const started = readVisitStarted(envelopeOf('visit.started'));
  const { finishedAt } = readVisitFinished(envelopeOf('visit.finished'));
  const { encounter: stored, pins } = await readCompletedCreateVisit(db, step);
  Object.assign(attempt.valuesUsed, pins);

  const identifier = { organizationId: step.organizationId, visitId: step.visitId };
  const encounter = finishedEncounterResource({
    identifier,
    encounter: stored,
    encounterClass: started.encounterClass,
    patient: pins.patientIhsNumber,
    practitioner: pins.practitionerIhsNumber,
    location: pins.locationId,
    startedAt: started.startedAt,
    finishedAt,
  });
  attempt.violations = validateStepPayload({
    step: 'update_visit',
    organizationId: step.organizationId,
    missingMappings: [],
    encounterId: stored.id,
    encounter,
  });
  if (attempt.violations.length > 0) return rejected(attempt);

  const found = await satusehat.findEncounters(identifier);
  // The client resolves a search only on 200 and an update only on 200; any other status throws.
  attempt.httpStatus = 200;
  if (found.length > 1) return { deadLettered: 'REMOTE_RECORD_AMBIGUOUS', attempt };
  const [current] = found;
  if (current?.remote.id !== stored.id) {
    // A stale or missing stored id is re-searched and classified with #35; until then the attempt fails.
    throw new Error(`the visit's Encounter at SATUSEHAT is ${current ? `"${current.remote.id}"` : 'missing'}, not the stored "${stored.id}"`);
  }
  if (current.status === 'finished' && endsAt(current.periodEnd, finishedAt)) {
    return { completed: current.remote, pins, attempt };
  }

  const updated = await satusehat.updateEncounter(stored.id, encounter);
  return { completed: updated, pins, attempt };
}

/**
 * Whether SATUSEHAT's `period.end` is the instant `finishedAt` as sent: compared
 * as instants to the second, since SATUSEHAT may write the same time another way.
 */
function endsAt(periodEnd: string | null, finishedAt: Date): boolean {
  const held = periodEnd === null ? Number.NaN : Date.parse(periodEnd);
  return !Number.isNaN(held) && platformTime(new Date(held)) === platformTime(finishedAt);
}
