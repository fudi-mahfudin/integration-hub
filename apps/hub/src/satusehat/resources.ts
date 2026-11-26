import type { OrganizationId } from '../auth/source-systems.js';
import type { IhsNumber, LocationId, VisitIdentifier } from './client.js';
import { platformTime } from './platform-time.js';

/** A FHIR resource as the hub builds it, to be checked by the Validation module and then sent. */
export type FhirResource = Record<string, unknown>;

/** The `encounter/{org}` identifier system of an organization's visits. */
export const encounterSystem = (org: OrganizationId) => `http://sys-ids.kemkes.go.id/encounter/${org}`;

const CLASS_DISPLAY = { AMB: 'ambulatory', IMP: 'inpatient encounter', EMER: 'emergency' } as const;

/** The encounter classes a visit may have (#6). */
export type EncounterClass = 'AMB' | 'IMP' | 'EMER';

/** What a create-visit Encounter says about its visit. */
export interface VisitEncounter {
  identifier: VisitIdentifier;
  encounterClass: EncounterClass;
  patient: IhsNumber;
  practitioner: IhsNumber;
  location: LocationId;
  startedAt: Date;
}

/** The FHIR R4 Encounter of a visit that has just started. */
export function visitEncounterResource(e: VisitEncounter): FhirResource {
  const start = platformTime(e.startedAt);
  return {
    resourceType: 'Encounter',
    identifier: [{ system: encounterSystem(e.identifier.organizationId), value: e.identifier.visitId }],
    status: 'arrived',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: e.encounterClass,
      display: CLASS_DISPLAY[e.encounterClass],
    },
    subject: { reference: `Patient/${e.patient}` },
    participant: [
      {
        type: [
          {
            coding: [
              { system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND', display: 'attender' },
            ],
          },
        ],
        individual: { reference: `Practitioner/${e.practitioner}` },
      },
    ],
    period: { start },
    location: [{ location: { reference: `Location/${e.location}` } }],
    statusHistory: [{ status: 'arrived', period: { start } }],
    serviceProvider: { reference: `Organization/${e.identifier.organizationId}` },
  };
}
