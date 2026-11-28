import type { WorldLocation, WorldOrganization, WorldPatient, WorldPractitioner } from '../world/world.js';
import { defineTemplate, DOCS } from './provenance.js';

/** Identifier system for the national ID number. */
export const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';
/** Identifier system for the mother's NIK, which a newborn without its own NIK is found by. */
export const MOTHER_NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik-ibu';
/** Identifier system for an IHS number. */
export const IHS_SYSTEM = 'https://fhir.kemkes.go.id/id/ihs-number';

/** A world patient as a Patient search hit. */
export const patientResource = defineTemplate(
  'patientResource',
  {
    tag: 'satusehat-docs',
    note: 'Patient search hit (by NIK, mother\'s NIK, or name + birthdate + gender), reduced to id, identifiers and the fields the fallbacks compare',
    link: DOCS.patient,
    fields: {
      'identifier[nik-ibu]': { tag: 'assumed', note: 'the docs show the mother\'s NIK on mother\'s-NIK hits; that every hit carries it is unverified' },
      birthDate: { tag: 'assumed', note: 'whether a NIK search hit carries birthDate is unverified' },
      gender: { tag: 'assumed', note: 'whether a NIK search hit carries gender is unverified' },
    },
  },
  (patient: WorldPatient): fhir4.Patient => ({
    resourceType: 'Patient',
    id: patient.ihsNumber,
    identifier: [
      { use: 'official', system: IHS_SYSTEM, value: patient.ihsNumber },
      { use: 'official', system: NIK_SYSTEM, value: patient.nik },
      { use: 'official', system: MOTHER_NIK_SYSTEM, value: patient.motherNik },
    ],
    name: [{ use: 'official', text: patient.name }],
    gender: patient.gender,
    birthDate: patient.birthDate,
  }),
);

/** A world practitioner as a Practitioner search hit. */
export const practitionerResource = defineTemplate(
  'practitionerResource',
  {
    tag: 'fhir-spec',
    note: 'FHIR R4 Practitioner with the NIK identifier and the IHS number as id',
    fields: {
      id: { tag: 'assumed', note: 'that the resource id is the IHS number is unverified for practitioners' },
      birthDate: { tag: 'assumed', note: 'whether a Practitioner search hit carries birthDate is unverified' },
      gender: { tag: 'assumed', note: 'whether a Practitioner search hit carries gender is unverified' },
    },
  },
  (practitioner: WorldPractitioner): fhir4.Practitioner => ({
    resourceType: 'Practitioner',
    id: practitioner.ihsNumber,
    identifier: [{ use: 'official', system: NIK_SYSTEM, value: practitioner.nik }],
    name: [{ use: 'official', text: practitioner.name }],
    gender: practitioner.gender,
    birthDate: practitioner.birthDate,
  }),
);

/** A world location as a Location search hit. */
export const locationResource = defineTemplate(
  'locationResource',
  { tag: 'fhir-spec', note: 'FHIR R4 Location with the local code under location/{org}, part of the organization' },
  (location: WorldLocation, organization: WorldOrganization): fhir4.Location => ({
    resourceType: 'Location',
    id: location.id,
    identifier: [{ system: `http://sys-ids.kemkes.go.id/location/${organization.id}`, value: location.code }],
    status: 'active',
    name: location.name,
    managingOrganization: { reference: `Organization/${organization.id}` },
  }),
);

/** A stored Encounter as the 201 body of its create, the 200 body of its update, and as a search hit. */
export const storedEncounter = defineTemplate(
  'storedEncounter',
  {
    tag: 'fhir-spec',
    note: 'FHIR R4 create and update return the stored resource with server-assigned id and meta',
    fields: {
      'meta.versionId': { tag: 'assumed', note: 'SATUSEHAT versionId format is unverified; the mock counts from "1" and adds 1 per applied update' },
    },
  },
  (args: { body: fhir4.Encounter; id: string; versionId: string; lastUpdated: Date }): fhir4.Encounter => ({
    ...args.body,
    resourceType: 'Encounter',
    id: args.id,
    meta: { versionId: args.versionId, lastUpdated: args.lastUpdated.toISOString() },
  }),
);

/** A stored MedicationRequest as the 201 body of its create and as a search hit. */
export const storedMedicationRequest = defineTemplate(
  'storedMedicationRequest',
  {
    tag: 'fhir-spec',
    note: 'FHIR R4 create returns the stored resource with server-assigned id and meta',
    fields: {
      'meta.versionId': { tag: 'assumed', note: 'SATUSEHAT versionId format is unverified; the mock counts from "1"' },
    },
  },
  (args: { body: fhir4.MedicationRequest; id: string; versionId: string; lastUpdated: Date }): fhir4.MedicationRequest => ({
    ...args.body,
    resourceType: 'MedicationRequest',
    id: args.id,
    meta: { versionId: args.versionId, lastUpdated: args.lastUpdated.toISOString() },
  }),
);

/** A stored MedicationDispense as the 201 body of its create and as a search hit. */
export const storedMedicationDispense = defineTemplate(
  'storedMedicationDispense',
  {
    tag: 'fhir-spec',
    note: 'FHIR R4 create returns the stored resource with server-assigned id and meta',
    fields: {
      'meta.versionId': { tag: 'assumed', note: 'SATUSEHAT versionId format is unverified; the mock counts from "1"' },
    },
  },
  (args: { body: fhir4.MedicationDispense; id: string; versionId: string; lastUpdated: Date }): fhir4.MedicationDispense => ({
    ...args.body,
    resourceType: 'MedicationDispense',
    id: args.id,
    meta: { versionId: args.versionId, lastUpdated: args.lastUpdated.toISOString() },
  }),
);

/** A search result Bundle with 0, 1 or more hits. */
export const searchBundle = defineTemplate(
  'searchBundle',
  { tag: 'fhir-spec', note: 'FHIR R4 searchset Bundle with total and one entry per hit' },
  (resources: readonly fhir4.FhirResource[]): fhir4.Bundle => ({
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((resource) => ({ resource, search: { mode: 'match' } })),
  }),
);
