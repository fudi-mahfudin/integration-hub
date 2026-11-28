import type { WorldKfaIngredient, WorldKfaProduct } from '../world/world.js';
import { defineTemplate } from './provenance.js';

/** One KFA record as `GET /kfa-v2/products?identifier=kfa&code=` describes it. */
export interface KfaProductResult {
  kfa_code: string;
  name: string;
  active: boolean;
  dosage_form: { code: string; name: string } | null;
  product_template: { kfa_code: string; name: string } | null;
  active_ingredients: { kfa_code: string; zat_aktif: string }[];
}

/** The body of a KFA v2 product lookup by code: one result, or none. */
export interface KfaLookupBody {
  total: number;
  result: KfaProductResult | null;
}

/** A KFA v2 product lookup by code, answered from the world's catalogue. */
export const kfaLookup = defineTemplate(
  'kfaLookup',
  {
    tag: 'assumed',
    note: 'KFA v2 product by code; product_template.kfa_code and active_ingredients[].kfa_code are named by the research (#2, #10), the envelope is unverified',
    fields: {
      'result.dosage_form': { tag: 'assumed', note: 'field name and code/name shape are unverified' },
      result: { tag: 'assumed', note: 'that an unknown code answers 200 with result null is unverified' },
    },
  },
  (
    found:
      | { product: WorldKfaProduct; template: WorldKfaProduct | undefined; ingredients: readonly WorldKfaIngredient[] }
      | { ingredient: WorldKfaIngredient }
      | undefined,
  ): KfaLookupBody => {
    if (found === undefined) return { total: 0, result: null };
    if ('ingredient' in found) {
      const { ingredient } = found;
      return {
        total: 1,
        result: { kfa_code: ingredient.code, name: ingredient.display, active: true, dosage_form: null, product_template: null, active_ingredients: [] },
      };
    }
    const { product, template, ingredients } = found;
    return {
      total: 1,
      result: {
        kfa_code: product.code,
        name: product.display,
        active: true,
        dosage_form: { code: product.doseForm.code, name: product.doseForm.display },
        product_template: template ? { kfa_code: template.code, name: template.display } : null,
        active_ingredients: ingredients.map((i) => ({ kfa_code: i.code, zat_aktif: i.display })),
      },
    };
  },
);
