import { findIhsNumber, type SourcePerson } from '../lookup/people.js';
import { findLocationId } from '../mapping/mappings.js';
import { sourceToPlatformTime } from '../time.js';
import { sysIdSystem } from '../satusehat/systems.js';
import { checkStep, searchThenCreate, sourceEvent, type DeadLettered, type StepRunner } from './step-runner.js';

const ENCOUNTER_CLASS_DISPLAY: Record<string, string> = {
  AMB: 'ambulatory',
  IMP: 'inpatient encounter',
  EMER: 'emergency',
};


/** What create visit pins on completion (#10); later steps read these, never the live mappings. */
export interface CreateVisitPins {
  [pin: string]: unknown;
  patientIhs: string;
  practitionerIhs: string;
  locationId: string;
}

/**
 * Create visit: `visit.started` → Encounter. Resolves the Location from the
 * operator mapping, the organization from the source registration and the
 * patient and practitioner IHS numbers by NIK, validates the Encounter
 * (#28), then searches it by `encounter/{org}` and creates it only if absent.
 */
export const createVisit: StepRunner = async (step, { db, fhir }, { used }) => {
  const data = (await sourceEvent(db, step.caseId, 'visit.started')).data as {
    patient: SourcePerson;
    practitioner: SourcePerson;
    encounterClass: string;
    locationCode: string;
    startedAt: string;
  };
  const organizationId = step.organizationId;

  // Local data first, so a missing mapping never reaches the platform.
  const locationId = await findLocationId(db, step.sourceId, data.locationCode);
  used.location = { localCode: data.locationCode, locationId: locationId ?? null };
  const mappings = [{ kind: 'location' as const, localCode: data.locationCode, found: locationId !== undefined }];
  if (locationId === undefined) return checkStep({ organizationId, mappings }) as DeadLettered;

  const patient = await findIhsNumber(fhir, 'Patient', data.patient);
  used.patient = patient ?? null;
  if (patient === undefined) return { outcome: 'dead_lettered', reason: 'PATIENT_NOT_FOUND' };
  const practitioner = await findIhsNumber(fhir, 'Practitioner', data.practitioner);
  used.practitioner = practitioner ?? null;
  if (practitioner === undefined) return { outcome: 'dead_lettered', reason: 'PRACTITIONER_NOT_FOUND' };

  const identifier = { system: sysIdSystem('encounter', organizationId), value: step.visitId };
  const pins: CreateVisitPins = { patientIhs: patient.ihsNumber, practitionerIhs: practitioner.ihsNumber, locationId };
  const encounter = visitEncounter({
    organizationId,
    visitId: step.visitId,
    encounterClass: data.encounterClass,
    pins,
    start: sourceToPlatformTime(data.startedAt),
  });
  const invalid = checkStep({ organizationId, mappings, resource: encounter });
  if (invalid) return invalid;

  const result = await searchThenCreate(fhir, 'Encounter', identifier, encounter);
  if (result.outcome !== 'completed') return result;
  return { ...result, pins };
};

/**
 * The visit's Encounter, as create visit sends it (`arrived`) and, with an
 * `end`, as update visit sends it (`finished`, #9). Built only from the
 * visit's own values: the pins and the stored `visit.started`.
 */
export function visitEncounter(v: {
  organizationId: string;
  visitId: string;
  encounterClass: string;
  pins: CreateVisitPins;
  /** Platform times (`…+00:00`). */
  start: string;
  end?: string;
}): Record<string, unknown> {
  const finished = v.end !== undefined;
  return {
    resourceType: 'Encounter',
    identifier: [{ system: sysIdSystem('encounter', v.organizationId), value: v.visitId }],
    status: finished ? 'finished' : 'arrived',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: v.encounterClass,
      display: ENCOUNTER_CLASS_DISPLAY[v.encounterClass],
    },
    subject: { reference: `Patient/${v.pins.patientIhs}` },
    participant: [
      {
        type: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' },
            ],
          },
        ],
        individual: { reference: `Practitioner/${v.pins.practitionerIhs}` },
      },
    ],
    period: finished ? { start: v.start, end: v.end } : { start: v.start },
    location: [{ location: { reference: `Location/${v.pins.locationId}` } }],
    statusHistory: finished
      ? [
          { status: 'arrived', period: { start: v.start, end: v.end } },
          { status: 'finished', period: { start: v.end, end: v.end } },
        ]
      : [{ status: 'arrived', period: { start: v.start } }],
    serviceProvider: { reference: `Organization/${v.organizationId}` },
  };
}
