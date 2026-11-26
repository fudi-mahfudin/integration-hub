/**
 * The Validation module (#9): checks what a step is about to send, just before
 * it is sent. Pure: a step payload in, its violations out. Any violation is
 * permanent and dead-letters the step; the reason is the first violation in
 * rule order, and every violation goes to the attempt log. The mock SATUSEHAT
 * checks the same payloads with its own code (ADR 0006).
 */
import type { OrganizationId } from '../auth/source-systems.js';
import type { KfaProduct } from '../kfa/kfa-product.js';
import { checkEncounter } from './encounter-rules.js';

/** The step dead-letter codes this module reports, in rule order (#9). */
export const RULE_ORDER = [
  'MAPPING_MISSING',
  'KFA_LEVEL_INVALID',
  'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
  'SUBSTITUTION_MISMATCH',
  'PAYLOAD_INVALID',
] as const;

/** A rule's code: also the step's dead-letter reason when it is the first violation. */
export type RuleCode = (typeof RULE_ORDER)[number];

/** One broken rule. */
export interface Violation {
  code: RuleCode;
  /** Where in the payload, as a FHIR path (`Encounter.period.start`); null when the rule is not about one field. */
  path: string | null;
  /** What is wrong, naming the bad value and what was expected. */
  message: string;
}

/** An operator mapping a step needed and did not find (#10). */
export interface MissingMapping {
  kind: 'location' | 'drug';
  /** The source system's local code that has no mapping. */
  localCode: string;
}

/**
 * What a step is about to send, as the Validation module checks it. The drug
 * steps carry the KFA details their rules judge; their FHIR resources join
 * them, with their PAYLOAD_INVALID rules, when those steps are built (#29, #30).
 */
export type StepPayload =
  | {
      step: 'create_visit';
      /** The case's organization: the `{org}` of its identifier systems and its serviceProvider. */
      organizationId: OrganizationId;
      missingMappings: readonly MissingMapping[];
      /** The Encounter about to be sent; null when a missing mapping meant it could not be built. */
      encounter: unknown;
    }
  | {
      step: 'submit_prescription';
      missingMappings: readonly MissingMapping[];
      /** The prescribed drug's KFA details; null when its drug code has no mapping. */
      product: KfaProduct | null;
    }
  | {
      step: 'submit_dispense';
      missingMappings: readonly MissingMapping[];
      /** The KFA product the completed prescription pinned. */
      prescribed: KfaProduct;
      /** The dispensed drug's KFA details; null when its drug code has no mapping. */
      dispensed: KfaProduct | null;
      /** Whether the source declared the dispense a substitution (`drug.dispensed.substitution`). */
      declaredSubstitution: boolean;
    };

/** Every violation of `payload`, in rule order; empty means it may be sent. */
export function validateStepPayload(payload: StepPayload): Violation[] {
  const violations: Violation[] = payload.missingMappings.map((m) => ({
    code: 'MAPPING_MISSING',
    path: null,
    message: `the ${m.kind} "${m.localCode}" has no mapping for this source system`,
  }));
  const add = (code: RuleCode, message: string) => void violations.push({ code, path: null, message });

  switch (payload.step) {
    case 'create_visit': {
      const fail = (path: string, message: string) =>
        void violations.push({ code: 'PAYLOAD_INVALID', path, message: `${path} ${message}` });
      if (payload.encounter !== null) checkEncounter(payload.encounter, payload.organizationId, fail);
      else if (payload.missingMappings.length === 0) add('PAYLOAD_INVALID', 'no Encounter was built, yet no mapping is missing');
      break;
    }
    case 'submit_prescription': {
      const { product } = payload;
      if (product && product.level !== 92 && product.level !== 93) {
        add('KFA_LEVEL_INVALID', `a prescription needs a KFA 92 or 93 product, got ${product.code} at level ${product.level}`);
      }
      break;
    }
    case 'submit_dispense': {
      const { prescribed, dispensed, declaredSubstitution } = payload;
      if (!dispensed) break;
      if (dispensed.level !== 93) {
        add('KFA_LEVEL_INVALID', `a dispense needs a KFA 93 product, got ${dispensed.code} at level ${dispensed.level}`);
        break;
      }
      const kind = classifyDispense(prescribed, dispensed);
      if (kind === 'therapeutic_substitution') {
        add(
          'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
          `the dispensed ${dispensed.code} has active ingredients [${[...dispensed.activeIngredients].sort().join(', ')}], ` +
            `the prescribed ${prescribed.code} has [${[...prescribed.activeIngredients].sort().join(', ')}]`,
        );
      } else if ((kind === 'substitution') !== declaredSubstitution) {
        add(
          'SUBSTITUTION_MISMATCH',
          `dispensing ${dispensed.code} for the prescribed ${prescribed.code} is ${kind === 'substitution' ? '' : 'not '}a substitution, ` +
            `but the source declared it ${declaredSubstitution ? '' : 'not '}one`,
        );
      }
      break;
    }
  }
  return violations.sort((a, b) => RULE_ORDER.indexOf(a.code) - RULE_ORDER.indexOf(b.code));
}

/**
 * How a dispensed actual product relates to the prescribed product (#9): the
 * prescribed one itself or derived from the prescribed virtual product
 * (`as_prescribed`); otherwise a `substitution` when the 91 sets are equal,
 * else a `therapeutic_substitution`.
 */
function classifyDispense(
  prescribed: KfaProduct,
  dispensed: KfaProduct,
): 'as_prescribed' | 'substitution' | 'therapeutic_substitution' {
  const asPrescribed =
    dispensed.code === prescribed.code || (prescribed.level === 92 && dispensed.parent92 === prescribed.code);
  if (asPrescribed) return 'as_prescribed';
  const ingredients = new Set(prescribed.activeIngredients);
  const dispensedIngredients = new Set(dispensed.activeIngredients);
  const sameSet = ingredients.size === dispensedIngredients.size && [...ingredients].every((c) => dispensedIngredients.has(c));
  return sameSet ? 'substitution' : 'therapeutic_substitution';
}
