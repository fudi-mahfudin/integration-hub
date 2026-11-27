import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { LocationId } from '../satusehat/client.js';
import { readSeedFile, seedSource } from './seed-file.js';

/**
 * The location mapping seed in the repo: the operator's mappings for the
 * simulator's source system, pointing at the world dataset's locations (#10).
 * Resolves to `apps/hub/seed/` from both `src/mapping` and `dist/mapping`.
 */
const LOCATION_MAPPING_SEED = new URL('../../seed/location-mappings.json', import.meta.url);

const seedSchema = z
  .array(
    z.object({
      source: z.string().min(1),
      locationCode: z.string().min(1).max(64),
      locationId: z.string().min(1),
      note: z.string().optional(),
    }),
  )
  .refine(
    (rows) => new Set(rows.map((r) => `${r.source}\u0000${r.locationCode}`)).size === rows.length,
    'duplicate (source, locationCode)',
  );

/**
 * Loads the seed file into the location mappings, idempotently: each
 * (source, locationCode) is upserted, so loading it again changes nothing,
 * and a changed seed entry takes effect at the next boot. The worker loads
 * it at boot. Throws naming the file if it is invalid.
 */
export async function loadLocationMappingSeed(db: Kysely<Database>, now: Date): Promise<void> {
  const rows = await readSeedFile(LOCATION_MAPPING_SEED, seedSchema);
  await upsertLocationMappings(
    db,
    rows.map((r) => ({ source: seedSource(r.source), localCode: r.locationCode, locationId: r.locationId, note: r.note ?? null })),
    now,
  );
}

/** One operator mapping of a source system's local location code, as the seed and the admin API write it. */
export interface LocationMapping {
  /** The source system whose local code it is. */
  source: SourceSystemId;
  /** The source system's own code. */
  localCode: string;
  /** The SATUSEHAT Location it maps to. */
  locationId: string;
  /** The operator's note, if any. */
  note: string | null;
}

/**
 * Upserts location mappings by (source, local code): the one write path of the
 * seed file and the admin API (#10). A row that already holds the same
 * values is left untouched, `updated_at` included, so reloading the seed
 * changes nothing.
 */
export async function upsertLocationMappings(db: Kysely<Database>, rows: readonly LocationMapping[], now: Date): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insertInto('location_mapping')
    .values(rows.map((r) => ({ source_system_id: r.source, location_code: r.localCode, location_id: r.locationId, note: r.note, updated_at: now })))
    .onConflict((oc) =>
      oc
        .constraint('location_mapping_pkey')
        .doUpdateSet((eb) => ({
          location_id: eb.ref('excluded.location_id'),
          note: eb.ref('excluded.note'),
          updated_at: eb.ref('excluded.updated_at'),
        }))
        .where((eb) =>
          eb.or([
            eb('location_mapping.location_id', '<>', eb.ref('excluded.location_id')),
            eb('location_mapping.note', 'is distinct from', eb.ref('excluded.note')),
          ]),
        ),
    )
    .execute();
}

/** A stored location mapping with when it last changed, if the operator mapped (source, `localCode`). */
export async function readLocationMapping(
  db: Kysely<Database>,
  source: SourceSystemId,
  localCode: string,
): Promise<(LocationMapping & { updatedAt: Date }) | undefined> {
  const row = await db
    .selectFrom('location_mapping')
    .select(['location_id', 'note', 'updated_at'])
    .where('source_system_id', '=', source)
    .where('location_code', '=', localCode)
    .executeTakeFirst();
  return row && { source, localCode, locationId: row.location_id, note: row.note, updatedAt: row.updated_at };
}

/** Deletes the location mapping of (source, `localCode`); resolves to whether there was one. */
export async function deleteLocationMapping(db: Kysely<Database>, source: SourceSystemId, localCode: string): Promise<boolean> {
  const deleted = await db
    .deleteFrom('location_mapping')
    .where('source_system_id', '=', source)
    .where('location_code', '=', localCode)
    .executeTakeFirst();
  return deleted.numDeletedRows > 0n;
}

/** The SATUSEHAT Location a source system's local location code maps to, if the operator mapped it. */
export async function findLocation(
  db: Kysely<Database>,
  source: SourceSystemId,
  locationCode: string,
): Promise<LocationId | undefined> {
  const row = await db
    .selectFrom('location_mapping')
    .select('location_id')
    .where('source_system_id', '=', source)
    .where('location_code', '=', locationCode)
    .executeTakeFirst();
  // Stored only from a mapping's locationId.
  return row?.location_id as LocationId | undefined;
}
