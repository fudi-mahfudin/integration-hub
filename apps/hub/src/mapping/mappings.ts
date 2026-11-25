import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.js';

/**
 * Operator mappings (#10), keyed by (source, local code): locations and
 * drugs. The seed file and (with #37) the admin API upsert the same tables;
 * nothing else writes them.
 */

export interface LocationSeedEntry {
  source: string;
  locationCode: string;
  /** SATUSEHAT Location id. */
  locationId: string;
  note?: string;
}

export interface DrugSeedEntry {
  source: string;
  /** The source's local drug code. */
  drugCode: string;
  /** The KFA code (92 or 93 for a prescription) it maps to. */
  kfaCode: string;
  note?: string;
}

/** The mapping seed file: `{ locations: [...], drugs?: [...] }`. */
export interface MappingSeed {
  locations: LocationSeedEntry[];
  drugs: DrugSeedEntry[];
}

export function readMappingSeed(path: string): MappingSeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`mapping seed ${path} is not readable JSON`, { cause: err });
  }
  const locations = (parsed as { locations?: unknown })?.locations;
  if (!Array.isArray(locations)) throw new Error(`mapping seed ${path} needs a "locations" array`);
  const drugs = (parsed as { drugs?: unknown })?.drugs ?? [];
  if (!Array.isArray(drugs)) throw new Error(`mapping seed ${path}: "drugs" must be an array`);
  requireFields(path, 'locations', locations, ['source', 'locationCode', 'locationId']);
  requireFields(path, 'drugs', drugs, ['source', 'drugCode', 'kfaCode']);
  return { locations: locations as LocationSeedEntry[], drugs: drugs as DrugSeedEntry[] };
}

function requireFields(path: string, list: string, entries: unknown[], fields: string[]): void {
  for (const [i, e] of entries.entries()) {
    for (const field of fields) {
      const value = (e as Record<string, unknown> | null)?.[field];
      if (typeof value !== 'string' || value === '') throw new Error(`mapping seed ${path}: ${list}[${i}] needs a non-empty "${field}"`);
    }
  }
}

/**
 * Upserts the seed, idempotently: rerunning it with the same file changes
 * nothing (not even `updated_at`); a changed entry overwrites the row.
 */
export async function loadMappingSeed(db: Kysely<Database>, seed: MappingSeed, now: Date): Promise<void> {
  await loadLocations(db, seed.locations, now);
  await loadDrugs(db, seed.drugs, now);
}

async function loadLocations(db: Kysely<Database>, locations: LocationSeedEntry[], now: Date): Promise<void> {
  if (locations.length === 0) return;
  await db
    .insertInto('location_mapping')
    .values(
      locations.map((l) => ({
        source_id: l.source,
        location_code: l.locationCode,
        location_id: l.locationId,
        note: l.note ?? null,
        updated_at: now,
      })),
    )
    .onConflict((oc) =>
      oc
        .constraint('location_mapping_pkey')
        .doUpdateSet({
          location_id: (eb) => eb.ref('excluded.location_id'),
          note: (eb) => eb.ref('excluded.note'),
          updated_at: (eb) => eb.ref('excluded.updated_at'),
        })
        .where(sql<boolean>`(location_mapping.location_id, location_mapping.note) is distinct from (excluded.location_id, excluded.note)`),
    )
    .execute();
}

async function loadDrugs(db: Kysely<Database>, drugs: DrugSeedEntry[], now: Date): Promise<void> {
  if (drugs.length === 0) return;
  await db
    .insertInto('drug_mapping')
    .values(drugs.map((d) => ({ source_id: d.source, drug_code: d.drugCode, kfa_code: d.kfaCode, note: d.note ?? null, updated_at: now })))
    .onConflict((oc) =>
      oc
        .constraint('drug_mapping_pkey')
        .doUpdateSet({
          kfa_code: (eb) => eb.ref('excluded.kfa_code'),
          note: (eb) => eb.ref('excluded.note'),
          updated_at: (eb) => eb.ref('excluded.updated_at'),
        })
        .where(sql<boolean>`(drug_mapping.kfa_code, drug_mapping.note) is distinct from (excluded.kfa_code, excluded.note)`),
    )
    .execute();
}

/** The KFA code for a source's local drug code, or undefined (`MAPPING_MISSING`). */
export async function findKfaCode(db: Kysely<Database>, sourceId: string, drugCode: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('drug_mapping')
    .select('kfa_code')
    .where('source_id', '=', sourceId)
    .where('drug_code', '=', drugCode)
    .executeTakeFirst();
  return row?.kfa_code;
}

/** The SATUSEHAT Location id for a source's local location code, or undefined (`MAPPING_MISSING`). */
export async function findLocationId(db: Kysely<Database>, sourceId: string, locationCode: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('location_mapping')
    .select('location_id')
    .where('source_id', '=', sourceId)
    .where('location_code', '=', locationCode)
    .executeTakeFirst();
  return row?.location_id;
}
