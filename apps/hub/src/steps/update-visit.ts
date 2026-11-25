import type { FhirResource } from '../satusehat/fhir-client.js';
import { sourceToPlatformTime } from '../time.js';
import { visitEncounter, type CreateVisitPins } from './create-visit.js';
import { checkStep, completedStep, sourceEvent, type StepRunner } from './step-runner.js';

/** What update visit pins on completion: the end time it sent (the rest are create visit's pins). */
export interface UpdateVisitPins {
  [pin: string]: unknown;
  /** `Encounter.period.end` as sent (`…+00:00`). */
  finishedAt: string;
}

/**
 * Update visit: `visit.finished` → the case's Encounter (create visit's
 * remote id) PUT as `finished`, rebuilt from create visit's pins and the
 * stored `visit.started` plus `period.end`. No `diagnosis` (#9, known risk).
 *
 * Effect-once for an update (the PUT analogue of search-then-create, ADR
 * 0005): read the Encounter first; if it is already `finished` with our end
 * time, an earlier attempt's PUT was applied and its answer lost, so adopt
 * the stored version instead of applying the change a second time (#12
 * counts a second applied PUT as a duplicate submission).
 */
export const updateVisit: StepRunner = async (step, { db, fhir }, { used }) => {
  const visit = await completedStep<CreateVisitPins>(db, step.caseId, 'create_visit');
  const encounterId = visit.remote.id;
  used.encounter = { id: encounterId };
  const started = (await sourceEvent(db, step.caseId, 'visit.started')).data as { encounterClass: string; startedAt: string };
  const finished = (await sourceEvent(db, step.caseId, 'visit.finished')).data as { finishedAt: string };

  const end = sourceToPlatformTime(finished.finishedAt);
  const encounter = {
    ...visitEncounter({
      organizationId: step.organizationId,
      visitId: step.visitId,
      encounterClass: started.encounterClass,
      pins: visit.pins,
      start: sourceToPlatformTime(started.startedAt),
      end,
    }),
    id: encounterId,
  };
  const invalid = checkStep({ organizationId: step.organizationId, resource: encounter });
  if (invalid) return invalid;

  // A 404 here (stale id) throws: transient for now; #35 adds the re-search / REMOTE_RECORD_MISSING.
  const current = await fhir.read('Encounter', encounterId);
  const stored = alreadyApplied(current, end) ? current : await fhir.update('Encounter', encounterId, encounter);
  const pins: UpdateVisitPins = { finishedAt: end };
  return { outcome: 'completed', remote: { type: 'Encounter', id: encounterId, version: stored.meta?.versionId ?? null }, pins };
};

function alreadyApplied(current: FhirResource, end: string): boolean {
  const period = current.period as { end?: unknown } | undefined;
  return current.status === 'finished' && period?.end === end;
}
