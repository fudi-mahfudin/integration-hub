import type { Kysely } from 'kysely';
import type { Database } from '../db/database.js';
import type { KfaClient } from './kfa-client.js';
import { parseKfaProduct, type KfaCode, type KfaDetails } from './kfa-product.js';

/** The KFA details of a code, and the status of the KFA v2 lookup that found them; null when they were already stored. */
export interface ResolvedKfaDetails {
  details: KfaDetails | undefined;
  httpStatus: number | null;
}

/**
 * The KFA details of `code`: the stored row when the hub has fetched the code
 * before, else fetched from KFA v2 once and stored, shared by every source
 * (#10). `details` is `undefined` when KFA has no such code; nothing is
 * stored then, so a code KFA adds later is found. A failed fetch throws and
 * stores nothing.
 */
export async function resolveKfaDetails(deps: { db: Kysely<Database>; kfa: KfaClient }, code: KfaCode, now: Date): Promise<ResolvedKfaDetails> {
  const { db, kfa } = deps;
  const stored = await readStored(db, code);
  if (stored) return { details: stored, httpStatus: null };

  const { httpStatus, details } = await kfa.findProduct(code);
  if (!details) return { details: undefined, httpStatus };
  const { product, display, doseForm } = details;
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
  // Another worker may have stored the code first; the stored row is what every case uses.
  const kept = await readStored(db, code);
  if (!kept) throw new Error(`KFA ${code} was just stored, yet no row reads back`);
  return { details: kept, httpStatus };
}

async function readStored(db: Kysely<Database>, code: KfaCode): Promise<KfaDetails | undefined> {
  const row = await db.selectFrom('kfa_product').selectAll().where('code', '=', code).executeTakeFirst();
  if (!row) return undefined;
  return {
    product: parseKfaProduct({ code: row.code, level: row.level, parent92: row.parent_92, activeIngredients: row.active_ingredients }),
    display: row.display,
    doseForm:
      row.dose_form_code !== null && row.dose_form_display !== null ? { code: row.dose_form_code, display: row.dose_form_display } : null,
  };
}
