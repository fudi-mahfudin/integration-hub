import type { Bundle, Location, Patient, Practitioner, Resource } from 'fhir/r4.js';
import type { WorldLocation, WorldPatient, WorldPractitioner } from '../world/world.js';
import { defineTemplate, docs, fhirSpec } from './provenance.js';

export const NIK_SYSTEM = 'https://fhir.kemkes.go.id/id/nik';
export const NIK_MOTHER_SYSTEM = 'https://fhir.kemkes.go.id/id/nik-ibu';
export const IHS_SYSTEM = 'https://fhir.kemkes.go.id/id/ihs-number';

export const searchBundle = defineTemplate({
  name: 'search Bundle (0, 1, 2+ hits)',
  provenance: { tag: 'fhir-spec', note: 'searchset Bundle with total and entry[].resource', link: fhirSpec.bundle },
  fields: {
    'entry[].fullUrl': { tag: 'assumed', note: 'mock base URL + type/id' },
  },
  build: (baseUrl: string, resources: Resource[]): Bundle => ({
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((resource) => ({
      fullUrl: `${baseUrl}/${resource.resourceType}/${resource.id ?? ''}`,
      resource,
      search: { mode: 'match' },
    })),
  }),
});

export const patientResource = defineTemplate({
  name: 'Patient',
  provenance: { tag: 'satusehat-docs', note: 'Patient by NIK search hit; only fields the hub reads', link: docs.patient },
  fields: {
    'identifier[nik-ibu]': { tag: 'assumed', note: 'mother\'s NIK carried as an identifier; system per SATUSEHAT naming' },
  },
  build: (p: WorldPatient): Patient => ({
    resourceType: 'Patient',
    id: p.ihs,
    meta: { versionId: '1', lastUpdated: '2025-01-01T00:00:00+00:00' },
    identifier: [
      { use: 'official', system: IHS_SYSTEM, value: p.ihs },
      { use: 'official', system: NIK_SYSTEM, value: p.nik },
      ...(p.motherNik ? [{ use: 'official' as const, system: NIK_MOTHER_SYSTEM, value: p.motherNik }] : []),
    ],
    active: true,
    name: [{ use: 'official', text: p.name }],
    gender: p.gender,
    birthDate: p.birthDate,
  }),
});

export const practitionerResource = defineTemplate({
  name: 'Practitioner',
  provenance: { tag: 'fhir-spec', note: 'Practitioner with NIK + IHS identifiers', link: fhirSpec.practitioner },
  fields: { qualification: { tag: 'assumed', note: 'pharmacist marked by qualification text only' } },
  build: (p: WorldPractitioner): Practitioner => ({
    resourceType: 'Practitioner',
    id: p.ihs,
    meta: { versionId: '1', lastUpdated: '2025-01-01T00:00:00+00:00' },
    identifier: [
      { use: 'official', system: IHS_SYSTEM, value: p.ihs },
      { use: 'official', system: NIK_SYSTEM, value: p.nik },
    ],
    name: [{ use: 'official', text: p.name }],
    gender: p.gender,
    birthDate: p.birthDate,
    qualification: [{ code: { text: p.role } }],
  }),
});

export const locationResource = defineTemplate({
  name: 'Location',
  provenance: { tag: 'fhir-spec', note: 'Location with managingOrganization', link: fhirSpec.location },
  build: (l: WorldLocation): Location => ({
    resourceType: 'Location',
    id: l.id,
    meta: { versionId: '1', lastUpdated: '2025-01-01T00:00:00+00:00' },
    status: 'active',
    name: l.name,
    managingOrganization: { reference: `Organization/${l.organizationId}` },
  }),
});

export const storedResource = defineTemplate({
  name: '201 create / stored Encounter or MedicationRequest',
  provenance: { tag: 'satusehat-docs', note: 'created resource echoed with server id and meta', link: docs.encounter },
  fields: {
    'meta.versionId': { tag: 'assumed', note: 'opaque string; the real format is unknown' },
    'meta.lastUpdated': { tag: 'fhir-spec', note: 'instant set by the server' },
  },
  build: (type: string, body: Resource, a: { id: string; versionId: string; lastUpdated: string }): Resource => ({
    ...body,
    resourceType: type as Resource['resourceType'],
    id: a.id,
    meta: { versionId: a.versionId, lastUpdated: a.lastUpdated },
  }),
});
