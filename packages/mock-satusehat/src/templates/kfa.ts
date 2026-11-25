import type { KfaProduct } from '../world/world.js';
import { defineTemplate, docs } from './provenance.js';

/**
 * KFA v2 product detail, `GET /kfa-v2/products?identifier=kfa&code=…`. The
 * public Postman collection has the endpoint but no success example, so the
 * envelope is assumed; the field names follow #10 (`product_template.kfa_code`,
 * `active_ingredients[].kfa_code`).
 */
export const kfaProductDetail = defineTemplate({
  name: 'KFA v2 product detail',
  provenance: { tag: 'satusehat-docs', note: 'KFA v2 product detail by KFA code; only the fields the hub reads', link: docs.kfa },
  fields: {
    total: { tag: 'assumed', note: 'envelope { total, result } not documented with an example' },
    'result.dosage_form': { tag: 'assumed', note: 'code/name pair; the world uses v3-orderableDrugForm codes, real KFA its own' },
    'result.product_template': { tag: 'assumed', note: 'null for a 92 or 91 (it is its own template, or has none)' },
    'result.active_ingredients[].zat_aktif': { tag: 'assumed', note: 'ingredient display name' },
  },
  build: (p: KfaProduct, byCode: ReadonlyMap<string, KfaProduct>) => {
    const parent = p.parentCode === undefined ? undefined : byCode.get(p.parentCode);
    return {
      total: 1,
      result: {
        kfa_code: p.code,
        name: p.display,
        active: true,
        dosage_form: p.doseForm ?? null,
        product_template: parent ? { kfa_code: parent.code, name: parent.display } : null,
        active_ingredients: p.ingredientCodes.map((c) => ({ kfa_code: c, zat_aktif: byCode.get(c)?.display ?? c })),
      },
    };
  },
});

export const kfaNotFound = defineTemplate({
  name: 'KFA v2 product not found (404)',
  provenance: { tag: 'assumed', note: 'status and body for an unknown code are undocumented; FastAPI-style { detail } as in the Postman error examples' },
  build: (code: string) => ({ detail: `product with kfa code ${code} not found` }),
});

export const kfaBadQuery = defineTemplate({
  name: 'KFA v2 unsupported query (400)',
  provenance: { tag: 'assumed', note: 'the mock only serves identifier=kfa&code=… (#12: unknown searches are 400)' },
  build: (query: string) => ({ detail: `unsupported KFA query: ${query}` }),
});
