import { readFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { LocationId } from '../satusehat/client.js';

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
  const path = LOCATION_MAPPING_SEED;
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`location mapping seed at "${path.pathname}" must be a readable JSON file`, { cause: err });
  }
  const parsed = seedSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`location mapping seed at "${path.pathname}" is invalid; ${problems.join('; ')}`);
  }
  if (parsed.data.length === 0) return;
  await db
    .insertInto('location_mapping')
    .values(
      parsed.data.map((r) => ({
        source_system_id: r.source,
        location_code: r.locationCode,
        location_id: r.locationId,
        note: r.note ?? null,
        updated_at: now,
      })),
    )
    .onConflict((oc) =>
      oc
        .constraint('location_mapping_pkey')
        .doUpdateSet((eb) => ({
          location_id: eb.ref('excluded.location_id'),
          note: eb.ref('excluded.note'),
          updated_at: eb.ref('excluded.updated_at'),
        }))
        // Leave rows the seed already matches untouched, so a reboot changes nothing.
        .where((eb) =>
          eb.or([
            eb('location_mapping.location_id', '<>', eb.ref('excluded.location_id')),
            eb('location_mapping.note', 'is distinct from', eb.ref('excluded.note')),
          ]),
        ),
    )
    .execute();
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
