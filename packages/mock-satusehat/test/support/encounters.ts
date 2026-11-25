import { encounterSystem, world } from './platform.js';

/** A create-visit payload that passes every mock rule; tests break it one field at a time. */
export function validEncounter(visitKey: string, org = world.organization.id): any {
  const patient = world.patients[0]!;
  const doctor = world.practitioners[0]!;
  const location = world.locations[0]!;
  return {
    resourceType: 'Encounter',
    identifier: [{ system: encounterSystem(org), value: visitKey }],
    status: 'arrived',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: { reference: `Patient/${patient.ihs}`, display: patient.name },
    participant: [
      {
        type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'ATND' }] }],
        individual: { reference: `Practitioner/${doctor.ihs}`, display: doctor.name },
      },
    ],
    period: { start: '2026-03-01T02:15:00+00:00' },
    location: [{ location: { reference: `Location/${location.id}`, display: location.name } }],
    statusHistory: [{ status: 'arrived', period: { start: '2026-03-01T02:15:00+00:00' } }],
    serviceProvider: { reference: `Organization/${org}` },
  };
}
