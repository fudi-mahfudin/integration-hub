import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.js';

/**
 * Operator mappings (#10), keyed by (source, local code). The seed file and
 * (with #37) the admin API upsert the same table; nothing else writes it.
 */

export interface LocationSeedEntry {
  source: string;
  locationCode: string;
  /** SATUSEHAT Location id. */
  locationId: string;
  note?: string;
}

/** The mapping seed file. Drug mappings join it with #29. */
export interface MappingSeed {
  locations: LocationSeedEntry[];
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
  for (const [i, e] of locations.entries()) {
    for (const field of ['source', 'locationCode', 'locationId'] as const) {
      if (typeof e?.[field] !== 'string' || e[field] === '') {
        throw new Error(`mapping seed ${path}: locations[${i}] needs a non-empty "${field}"`);
      }
    }
  }
  return { locations: locations as LocationSeedEntry[] };
}

/**
 * Upserts the seed, idempotently: rerunning it with the same file changes
 * nothing (not even `updated_at`); a changed entry overwrites the row.
 */
export async function loadMappingSeed(db: Kysely<Database>, seed: MappingSeed, now: Date): Promise<void> {
  if (seed.locations.length === 0) return;
  await db
    .insertInto('location_mapping')
    .values(
      seed.locations.map((l) => ({
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
