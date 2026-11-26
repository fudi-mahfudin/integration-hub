import { z } from 'zod';
import type { Brand } from '../brand.js';

/** A code from the national drug dictionary (KFA). */
export type KfaCode = Brand<string, 'KfaCode'>;

/**
 * What the hub knows about one KFA code (#9, #10): its level, the virtual
 * product (92) an actual product (93) derives from, and its active
 * ingredients as a set of 91 codes. Two products have the same active
 * ingredients when their 91 sets are equal; strength is never compared.
 */
export interface KfaProduct {
  code: KfaCode;
  /** 91 ingredient, 92 virtual product, 93 actual product; anything else is kept as given so it can be rejected. */
  level: number;
  /** For an actual product, its virtual product; otherwise null. */
  parent92: KfaCode | null;
  /** The 91 codes of its active ingredients. */
  activeIngredients: readonly KfaCode[];
}

const kfaCode = z
  .string()
  .regex(/^\d+$/, 'must be a KFA code of digits')
  // Checked just above: this is where a string of digits becomes a KFA code.
  .transform((code) => code as KfaCode);

const kfaProductSchema = z.object({
  code: kfaCode,
  level: z.number().int(),
  parent92: kfaCode.nullable(),
  activeIngredients: z.array(kfaCode),
});

/**
 * Parses KFA details at a boundary (the KFA API, a stored row, a pin).
 * @throws Error naming the problems when `value` is not a KFA product.
 */
export function parseKfaProduct(value: unknown): KfaProduct {
  const parsed = kfaProductSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`expected KFA details, got ${JSON.stringify(value)}; ${problems.join('; ')}`);
  }
  return parsed.data;
}
