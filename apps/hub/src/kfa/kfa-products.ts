import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { KfaClient } from './kfa-client.js';
import { parseKfaProduct, type KfaCode, type KfaDetails } from './kfa-product.js';

/**
 * The KFA details of `code`: the stored row when the hub has fetched the code
 * before, else fetched from KFA v2 once and stored, shared by every source
 * (#10). Resolves to `undefined` when KFA has no such code; nothing is stored
 * then, so a code KFA adds later is found. A failed fetch throws and stores nothing.
 */
export async function resolveKfaDetails(deps: { db: Kysely<Database>; kfa: KfaClient }, code: KfaCode, now: Date): Promise<KfaDetails | undefined> {
  const { db, kfa } = deps;
  const stored = await db.selectFrom('kfa_product').selectAll().where('code', '=', code).executeTakeFirst();
  if (stored) {
    return {
      product: parseKfaProduct({
        code: stored.code,
        level: stored.level,
        parent92: stored.parent_92,
        activeIngredients: stored.active_ingredients,
      }),
      display: stored.display,
      doseForm:
        stored.dose_form_code !== null && stored.dose_form_display !== null
          ? { code: stored.dose_form_code, display: stored.dose_form_display }
          : null,
    };
  }

  const fetched = await kfa.findProduct(code);
  if (!fetched) return undefined;
  const { product, display, doseForm } = fetched;
  // Two workers may fetch the same code at once: both got the same details, and the first insert stands.
  await db
    .insertInto('kfa_product')
    .values({
      code: product.code,
      display,
      level: product.level,
      parent_92: product.parent92,
      active_ingredients: JSON.stringify(product.activeIngredients),
      dose_form_code: doseForm?.code ?? null,
      dose_form_display: doseForm?.display ?? null,
      fetched_at: now,
    })
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
  return fetched;
}
