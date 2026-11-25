import { findIhsNumber, type SourcePerson } from '../lookup/people.js';
import { findLocationId } from '../mapping/mappings.js';
import { sourceToPlatformTime } from '../time.js';
import { checkStep, searchThenCreate, sourceEvent, type DeadLettered, type StepRunner } from './step-runner.js';

const ENCOUNTER_CLASS_DISPLAY: Record<string, string> = {
  AMB: 'ambulatory',
  IMP: 'inpatient encounter',
  EMER: 'emergency',
};

/** `http://sys-ids.kemkes.go.id/encounter/{org}`: the visit's identifier system (#6, #9). */
export const encounterSystem = (organizationId: string) => `http://sys-ids.kemkes.go.id/encounter/${organizationId}`;

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

  const identifier = { system: encounterSystem(organizationId), value: step.visitId };
  const start = sourceToPlatformTime(data.startedAt);
  const encounter = {
    resourceType: 'Encounter',
    identifier: [identifier],
    status: 'arrived',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: data.encounterClass,
      display: ENCOUNTER_CLASS_DISPLAY[data.encounterClass],
    },
    subject: { reference: `Patient/${patient.ihsNumber}` },
    participant: [
      {
        type: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' },
            ],
          },
        ],
        individual: { reference: `Practitioner/${practitioner.ihsNumber}` },
      },
    ],
    period: { start },
    location: [{ location: { reference: `Location/${locationId}` } }],
    statusHistory: [{ status: 'arrived', period: { start } }],
    serviceProvider: { reference: `Organization/${organizationId}` },
  };
  const invalid = checkStep({ organizationId, mappings, resource: encounter });
  if (invalid) return invalid;

  const result = await searchThenCreate(fhir, 'Encounter', identifier, encounter);
  if (result.outcome !== 'completed') return result;
  const pins: CreateVisitPins = { patientIhs: patient.ihsNumber, practitionerIhs: practitioner.ihsNumber, locationId };
  return { ...result, pins };
};
