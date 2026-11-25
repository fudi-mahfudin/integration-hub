import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorld } from '@integration-hub/mock-satusehat/world';

/** The mock's world dataset; tests read people and places from it, never copy them. */
export const world = loadWorld();

export const WORLD_SOURCE_API_KEY = 'world-source-key';

/** One source registered under the world's organization, so the mock accepts its records. */
export const WORLD_SOURCE = { id: 'world-source', organizationId: world.organization.id, apiKey: WORLD_SOURCE_API_KEY };

/** `world-source`'s local location codes, one per world location. */
export const WORLD_LOCATIONS = world.locations.map((l, i) => ({ code: `LOC-${i + 1}`, id: l.id }));

export interface LocationSeedEntry {
  source: string;
  locationCode: string;
  locationId: string;
}

export interface DrugSeedEntry {
  source: string;
  drugCode: string;
  kfaCode: string;
}

/** `world-source`'s local drug codes: `DRUG-{kfa code}` for every world KFA product (91s included, for KFA_LEVEL_INVALID). */
export const WORLD_DRUGS = world.kfaProducts.map((p) => ({ code: `DRUG-${p.code}`, product: p }));
/** A world KFA product of `level` and its `world-source` local code. */
export const worldDrug = (level: 91 | 92 | 93) => WORLD_DRUGS.find((d) => d.product.level === level)!;

/** Writes a mapping seed file to a temp dir and returns its path (for `MAPPING_SEED_PATH`). */
export function writeMappingSeed(locations: LocationSeedEntry[], drugs: DrugSeedEntry[] = []): string {
  const path = join(mkdtempSync(join(tmpdir(), 'hub-seed-')), 'mappings.json');
  writeFileSync(path, JSON.stringify({ locations, drugs }));
  return path;
}

const worldLocationEntries = () => WORLD_LOCATIONS.map((l) => ({ source: WORLD_SOURCE.id, locationCode: l.code, locationId: l.id }));
const worldDrugEntries = () => WORLD_DRUGS.map((d) => ({ source: WORLD_SOURCE.id, drugCode: d.code, kfaCode: d.product.code }));

/** A seed mapping every `WORLD_LOCATIONS` and `WORLD_DRUGS` code for `world-source`, plus `extraDrugs`. */
export function worldMappingSeed(extraDrugs: DrugSeedEntry[] = []): string {
  return writeMappingSeed(worldLocationEntries(), [...worldDrugEntries(), ...extraDrugs]);
}

/**
 * Env for a hub and a worker wired to the mock at `mockBaseUrl`, the database
 * at `databaseUrl` and the world source. Spread your overrides after it.
 */
export function satusehatEnv(mockBaseUrl: string, databaseUrl: string, seedPath = worldMappingSeed()): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    HUB_SOURCES: JSON.stringify([WORLD_SOURCE]),
    SATUSEHAT_AUTH_URL: `${mockBaseUrl}/oauth2/v1`,
    SATUSEHAT_FHIR_URL: `${mockBaseUrl}/fhir-r4/v1`,
    SATUSEHAT_KFA_URL: `${mockBaseUrl}/kfa-v2`,
    SATUSEHAT_CLIENT_ID: world.organization.clientId,
    SATUSEHAT_CLIENT_SECRET: world.organization.clientSecret,
    MAPPING_SEED_PATH: seedPath,
    WORKER_POLL_INTERVAL_MS: '20',
  };
}

export const worldPatient = world.patients.find((p) => !p.nearMiss) as (typeof world.patients)[number];
export const worldPhysician = world.practitioners.find((p) => p.role === 'physician') as (typeof world.practitioners)[number];

/** A `visit.started` for a world patient and physician at a mapped location; `data` is shallow-merged. */
export function worldVisitStarted(overrides: { visitId?: string; data?: Record<string, unknown> } = {}) {
  return {
    type: 'visit.started',
    visitId: overrides.visitId ?? `V-${randomUUID()}`,
    occurredAt: '2026-03-02T08:00:00+07:00',
    data: {
      patient: { nik: worldPatient.nik, mrn: 'MRN-0001' },
      practitioner: { nik: worldPhysician.nik },
      encounterClass: 'AMB',
      locationCode: WORLD_LOCATIONS[0]!.code,
      startedAt: '2026-03-02T08:00:00+07:00',
      ...overrides.data,
    },
  };
}

export const worldPharmacist = world.practitioners.find((p) => p.role === 'pharmacist') as (typeof world.practitioners)[number];

/** A single-item `prescription.written` for `visitId` by a world physician, of a mapped 93 by default; `item` is shallow-merged. */
export function worldPrescriptionWritten(visitId: string, item: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    type: 'prescription.written',
    visitId,
    occurredAt: '2026-03-02T08:30:00+07:00',
    data: {
      prescriptionId: `RX-${visitId}`,
      authoredAt: '2026-03-02T08:30:00+07:00',
      requester: { nik: worldPhysician.nik },
      items: [
        {
          itemId: `RX-${visitId}-1`,
          drugCode: worldDrug(93).code,
          quantity: 10,
          dosage: { text: '3 x 1 sesudah makan', timesPerDay: 3, doseAmount: 1, routeCode: 'O' },
          ...item,
        },
      ],
      ...data,
    },
  };
}

/** The world organization's `prescription/{org}` identifier system. */
export const PRESCRIPTION_SYSTEM = `http://sys-ids.kemkes.go.id/prescription/${world.organization.id}`;

/** The world organization's `encounter/{org}` identifier system. */
export const ENCOUNTER_SYSTEM = `http://sys-ids.kemkes.go.id/encounter/${world.organization.id}`;

/** An Encounter for `visitId` as another platform client would have created it; plant with `MockClient.insertRecord`. */
export function plantedEncounter(visitId: string) {
  const start = '2026-03-02T01:00:00+00:00';
  return {
    resourceType: 'Encounter' as const,
    identifier: [{ system: ENCOUNTER_SYSTEM, value: visitId }],
    status: 'arrived' as const,
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
    subject: { reference: `Patient/${worldPatient.ihs}` },
    participant: [{ individual: { reference: `Practitioner/${worldPhysician.ihs}` } }],
    period: { start },
    location: [{ location: { reference: `Location/${world.locations[0]!.id}` } }],
    serviceProvider: { reference: `Organization/${world.organization.id}` },
  };
}
