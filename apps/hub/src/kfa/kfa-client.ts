import { z } from 'zod';
import type { SatusehatConfig } from '../config.js';
import { SatusehatRequestError, SatusehatResponseError } from '../satusehat/errors.js';
import type { AttemptCalls, SatusehatTransport } from '../satusehat/transport.js';
import { parseKfaProduct, type KfaCode, type KfaDetails } from './kfa-product.js';

/** What a KFA v2 lookup answered: the status read, and the details, or `undefined` when KFA has no such code. */
export interface KfaLookup {
  httpStatus: 200 | 404;
  details: KfaDetails | undefined;
}

/** The KFA v2 call the hub makes. It takes the same access token as FHIR (#14). */
export interface KfaClient {
  /**
   * Looks `code` up. KFA has no such code when it answers 200 with no result
   * or 404 (which of the two the real KFA v2 sends is unverified). Any other
   * status throws `SatusehatRequestError`; a body of the wrong shape
   * throws `SatusehatResponseError`; no full answer within the time limit
   * throws `SatusehatTimeoutError` (see `SatusehatTransport`).
   */
  findProduct(code: KfaCode): Promise<KfaLookup>;
}

const kfaRef = z.object({ kfa_code: z.string().min(1) });

/** The fields of `GET products?identifier=kfa&code=` the hub reads (#10); everything else is ignored. */
const lookupSchema = z.object({
  result: z
    .object({
      kfa_code: z.string().min(1),
      name: z.string().min(1),
      dosage_form: z.object({ code: z.string().min(1), name: z.string().min(1) }).nullish(),
      product_template: kfaRef.nullish(),
      active_ingredients: z.array(kfaRef).nullish(),
    })
    .nullable(),
});

/**
 * Builds the KFA v2 client for one attempt, over the process's transport (the
 * same token as FHIR, timeouts, read retries) and the attempt's `calls`.
 * Only the composition root calls this.
 */
export function createKfaClient(deps: { config: Pick<SatusehatConfig, 'kfaUrl'>; transport: SatusehatTransport; calls: AttemptCalls }): KfaClient {
  const { config, transport, calls } = deps;
  const get = (url: URL) => transport.send(calls, { api: 'kfa', method: 'GET', url, accept: 'application/json' });

  return {
    async findProduct(code) {
      const url = new URL(`products?${new URLSearchParams({ identifier: 'kfa', code })}`, config.kfaUrl);
      const res = await get(url);
      const { text } = res;
      if (res.status === 404) return { httpStatus: 404, details: undefined };
      if (res.status !== 200) throw new SatusehatRequestError('GET', url, res.status, text, res.retryAfter);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new SatusehatResponseError('GET', url, 'a body that is not JSON', { cause: err });
      }
      const parsed = lookupSchema.safeParse(json);
      if (!parsed.success) {
        const problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        throw new SatusehatResponseError('GET', url, `an unexpected KFA body; ${problems.join('; ')}`);
      }
      const { result } = parsed.data;
      if (result === null) return { httpStatus: 200, details: undefined };
      if (result.kfa_code !== code) throw new SatusehatResponseError('GET', url, `KFA ${result.kfa_code} for the lookup of ${code}`);
      const details: KfaDetails = {
        product: parseKfaProduct({
          code: result.kfa_code,
          // KFA v2 carries no level field: a code's level is its two-digit prefix (91 ingredient, 92 virtual, 93 actual product).
          level: Number(result.kfa_code.slice(0, 2)),
          parent92: result.product_template?.kfa_code ?? null,
          activeIngredients: (result.active_ingredients ?? []).map((i) => i.kfa_code),
        }),
        display: result.name,
        doseForm: result.dosage_form ? { code: result.dosage_form.code, display: result.dosage_form.name } : null,
      };
      return { httpStatus: 200, details };
    },
  };
}
