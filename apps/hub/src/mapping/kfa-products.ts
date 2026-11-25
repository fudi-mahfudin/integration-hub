import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { KfaClient, KfaDetails } from '../satusehat/fhir-client.js';
import type { Clock } from '../tokens.js';

/**
 * KFA product details (#10): fetched from KFA v2 on first use and stored,
 * shared by all sources, no TTL. A code KFA does not know is undefined (and
 * not stored); a KFA timeout or 5xx throws, so the attempt is transient.
 * Replay (#37) must re-fetch the codes the failed step uses.
 */
export async function kfaProduct(db: Kysely<Database>, kfa: KfaClient, code: string, clock: Clock): Promise<KfaDetails | undefined> {
  const row = await db.selectFrom('kfa_product').selectAll().where('kfa_code', '=', code).executeTakeFirst();
  if (row) {
    return {
      code: row.kfa_code,
      level: row.level,
      display: row.display,
      parent92: row.parent_92,
      ingredients: row.ingredients,
      doseForm: row.dose_form_code !== null && row.dose_form_name !== null ? { code: row.dose_form_code, name: row.dose_form_name } : null,
    };
  }
  const fetched = await kfa.product(code);
  if (fetched === undefined) return undefined;
  const values = {
    level: fetched.level,
    display: fetched.display,
    parent_92: fetched.parent92,
    ingredients: JSON.stringify(fetched.ingredients),
    dose_form_code: fetched.doseForm?.code ?? null,
    dose_form_name: fetched.doseForm?.name ?? null,
    fetched_at: clock(),
  };
  await db
    .insertInto('kfa_product')
    .values({ kfa_code: code, ...values })
    .onConflict((oc) => oc.column('kfa_code').doUpdateSet(values))
    .execute();
  return fetched;
}
