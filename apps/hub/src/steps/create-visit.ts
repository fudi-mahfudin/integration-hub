import { findIhsNumber, type SourcePerson } from '../lookup/people.js';
import { findLocationId } from '../mapping/location-mappings.js';
import { sourceToPlatformTime } from '../time.js';
import { searchThenCreate, sourceEvent, type StepRunner } from './step-runner.js';

const ENCOUNTER_CLASS_DISPLAY: Record<string, string> = {
  AMB: 'ambulatory',
  IMP: 'inpatient encounter',
  EMER: 'emergency',
};

/** `http://sys-ids.kemkes.go.id/encounter/{org}`: the visit's identifier system (#6, #9). */
export const encounterSystem = (organizationId: string) => `http://sys-ids.kemkes.go.id/encounter/${organizationId}`;

/**
 * Create visit: `visit.started` → Encounter. Resolves the Location from the
 * operator mapping, the organization from the source registration and the
 * patient and practitioner IHS numbers by NIK, then searches the Encounter by
 * `encounter/{org}` and creates it only if absent.
 */
export const createVisit: StepRunner = async (step, { db, fhir }) => {
  const data = (await sourceEvent(db, step.caseId, 'visit.started')).data as {
    patient: SourcePerson;
    practitioner: SourcePerson;
    encounterClass: string;
    locationCode: string;
    startedAt: string;
  };

  // Local data first, so a missing mapping never reaches the platform.
  const locationId = await findLocationId(db, step.sourceId, data.locationCode);
  if (locationId === undefined) return { outcome: 'dead_lettered', reason: 'MAPPING_MISSING' };
  const patientIhs = await findIhsNumber(fhir, 'Patient', data.patient);
  if (patientIhs === undefined) return { outcome: 'dead_lettered', reason: 'PATIENT_NOT_FOUND' };
  const practitionerIhs = await findIhsNumber(fhir, 'Practitioner', data.practitioner);
  if (practitionerIhs === undefined) return { outcome: 'dead_lettered', reason: 'PRACTITIONER_NOT_FOUND' };

  const identifier = { system: encounterSystem(step.organizationId), value: step.visitId };
  const start = sourceToPlatformTime(data.startedAt);
  return searchThenCreate(fhir, 'Encounter', identifier, () => ({
    resourceType: 'Encounter',
    identifier: [identifier],
    status: 'arrived',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: data.encounterClass,
      display: ENCOUNTER_CLASS_DISPLAY[data.encounterClass],
    },
    subject: { reference: `Patient/${patientIhs}` },
    participant: [
      {
        type: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' },
            ],
          },
        ],
        individual: { reference: `Practitioner/${practitionerIhs}` },
      },
    ],
    period: { start },
    location: [{ location: { reference: `Location/${locationId}` } }],
    statusHistory: [{ status: 'arrived', period: { start } }],
    serviceProvider: { reference: `Organization/${step.organizationId}` },
  }));
};
