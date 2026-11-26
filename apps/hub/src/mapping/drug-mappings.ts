import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { SourceSystemId } from '../auth/source-systems.js';
import type { Database } from '../db/database.js';
import type { KfaCode } from '../kfa/kfa-product.js';
import { readSeedFile } from './seed-file.js';

/**
 * The drug mapping seed in the repo: the operator's mappings of the
 * simulator's local drug codes to the world dataset's KFA codes (#10), plus
 * two deliberately wrong entries (noted as such) for the KFA failure paths.
 * Resolves to `apps/hub/seed/` from both `src/mapping` and `dist/mapping`.
 */
const DRUG_MAPPING_SEED = new URL('../../seed/drug-mappings.json', import.meta.url);

const seedSchema = z
  .array(
    z.object({
      source: z.string().min(1),
      drugCode: z.string().min(1).max(64),
      kfaCode: z.string().regex(/^\d+$/, 'must be a KFA code of digits'),
      note: z.string().optional(),
    }),
  )
  .refine((rows) => new Set(rows.map((r) => `${r.source}\u0000${r.drugCode}`)).size === rows.length, 'duplicate (source, drugCode)');

/**
 * Loads the seed file into the drug mappings, idempotently: each
 * (source, drugCode) is upserted, so loading it again changes nothing, and a
 * changed seed entry takes effect at the next boot. The worker loads it at
 * boot. Throws naming the file if it is invalid.
 */
export async function loadDrugMappingSeed(db: Kysely<Database>, now: Date): Promise<void> {
  const rows = await readSeedFile(DRUG_MAPPING_SEED, seedSchema);
  if (rows.length === 0) return;
  await db
    .insertInto('drug_mapping')
    .values(
      rows.map((r) => ({ source_system_id: r.source, drug_code: r.drugCode, kfa_code: r.kfaCode, note: r.note ?? null, updated_at: now })),
    )
    .onConflict((oc) =>
      oc
        .constraint('drug_mapping_pkey')
        .doUpdateSet((eb) => ({
          kfa_code: eb.ref('excluded.kfa_code'),
          note: eb.ref('excluded.note'),
          updated_at: eb.ref('excluded.updated_at'),
        }))
        // Leave rows the seed already matches untouched, so a reboot changes nothing.
        .where((eb) =>
          eb.or([
            eb('drug_mapping.kfa_code', '<>', eb.ref('excluded.kfa_code')),
            eb('drug_mapping.note', 'is distinct from', eb.ref('excluded.note')),
          ]),
        ),
    )
    .execute();
}

/** The KFA code a source system's local drug code maps to, if the operator mapped it. */
export async function findKfaCode(db: Kysely<Database>, source: SourceSystemId, drugCode: string): Promise<KfaCode | undefined> {
  const row = await db
    .selectFrom('drug_mapping')
    .select('kfa_code')
    .where('source_system_id', '=', source)
    .where('drug_code', '=', drugCode)
    .executeTakeFirst();
  // Stored only from a seed or mapping entry checked to be a KFA code of digits.
  return row?.kfa_code as KfaCode | undefined;
}
