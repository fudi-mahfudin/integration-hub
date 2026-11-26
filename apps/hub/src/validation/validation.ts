/**
 * The Validation module (#9): checks what a step is about to send, just before
 * it is sent. Pure: a step payload in, its violations out. Any violation is
 * permanent and dead-letters the step; the reason is the first violation in
 * rule order, and every violation goes to the attempt log. The mock SATUSEHAT
 * checks the same payloads with its own code (ADR 0006).
 */
import type { OrganizationId } from '../auth/source-systems.js';
import { judgeDispense, type KfaCode, type KfaProduct } from '../kfa/kfa-product.js';
import { checkEncounter } from './encounter-rules.js';
import { checkMedicationDispense } from './medication-dispense-rules.js';
import { checkMedicationRequest } from './medication-request-rules.js';

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

/**
 * An operator mapping a step needed and did not find (#10): a local code with
 * no mapping, or a drug code mapped to a KFA code KFA does not know.
 */
export type MissingMapping =
  | {
      kind: 'location' | 'drug';
      /** The source system's local code that has no mapping. */
      localCode: string;
    }
  | {
      kind: 'kfa';
      /** The source system's local drug code. */
      localCode: string;
      /** The KFA code it maps to, which KFA does not know. */
      kfaCode: KfaCode;
    };

/** What a step is about to send, as the Validation module checks it. The drug steps carry the KFA details their rules judge. */
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
      /** The case's organization: the `{org}` of its identifier systems and the dispense performer. */
      organizationId: OrganizationId;
      missingMappings: readonly MissingMapping[];
      /** The prescribed drug's KFA details; null when its drug code has no mapping. */
      product: KfaProduct | null;
      /** The MedicationRequest about to be sent; null when a missing mapping meant it could not be built. */
      medicationRequest: unknown;
    }
  | {
      step: 'submit_dispense';
      /** The case's organization: the `{org}` of its identifier systems. */
      organizationId: OrganizationId;
      missingMappings: readonly MissingMapping[];
      /** The KFA product the completed prescription pinned. */
      prescribed: KfaProduct;
      /** The dispensed drug's KFA details; null when its drug code has no mapping. */
      dispensed: KfaProduct | null;
      /** Whether the source declared the dispense a substitution (`drug.dispensed.substitution`). */
      declaredSubstitution: boolean;
      /** The MedicationDispense about to be sent; null when a missing mapping meant it could not be built. */
      medicationDispense: unknown;
    };

/** Every violation of `payload`, in rule order; empty means it may be sent. */
export function validateStepPayload(payload: StepPayload): Violation[] {
  const violations: Violation[] = payload.missingMappings.map((m) => ({
    code: 'MAPPING_MISSING',
    path: null,
    message:
      m.kind === 'kfa'
        ? `the drug "${m.localCode}" maps to KFA ${m.kfaCode}, which KFA does not know`
        : `the ${m.kind} "${m.localCode}" has no mapping for this source system`,
  }));
  const add = (code: RuleCode, message: string) => void violations.push({ code, path: null, message });
  const fail = (path: string, message: string) =>
    void violations.push({ code: 'PAYLOAD_INVALID', path, message: `${path} ${message}` });

  switch (payload.step) {
    case 'create_visit': {
      if (payload.encounter !== null) checkEncounter(payload.encounter, payload.organizationId, fail);
      else if (payload.missingMappings.length === 0) add('PAYLOAD_INVALID', 'no Encounter was built, yet no mapping is missing');
      break;
    }
    case 'submit_prescription': {
      const { product } = payload;
      if (product && product.level !== 92 && product.level !== 93) {
        add('KFA_LEVEL_INVALID', `a prescription needs a KFA 92 or 93 product, got ${product.code} at level ${product.level}`);
      }
      if (payload.medicationRequest !== null) checkMedicationRequest(payload.medicationRequest, payload.organizationId, fail);
      else if (payload.missingMappings.length === 0) add('PAYLOAD_INVALID', 'no MedicationRequest was built, yet no mapping is missing');
      break;
    }
    case 'submit_dispense': {
      const { prescribed, dispensed, declaredSubstitution } = payload;
      const judgement = dispensed?.level === 93 ? judgeDispense(prescribed, dispensed) : null;
      if (dispensed && dispensed.level !== 93) {
        add('KFA_LEVEL_INVALID', `a dispense needs a KFA 93 product, got ${dispensed.code} at level ${dispensed.level}`);
      } else if (dispensed && judgement === 'therapeutic_substitution') {
        add(
          'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
          `the dispensed ${dispensed.code} has active ingredients [${[...dispensed.activeIngredients].sort().join(', ')}], ` +
            `the prescribed ${prescribed.code} has [${[...prescribed.activeIngredients].sort().join(', ')}]`,
        );
      } else if (dispensed && judgement !== null && (judgement === 'substitution') !== declaredSubstitution) {
        add(
          'SUBSTITUTION_MISMATCH',
          `dispensing ${dispensed.code} for the prescribed ${prescribed.code} is ${judgement === 'substitution' ? '' : 'not '}a substitution, ` +
            `but the source declared it ${declaredSubstitution ? '' : 'not '}one`,
        );
      }
      if (payload.medicationDispense !== null) {
        checkMedicationDispense(payload.medicationDispense, payload.organizationId, judgement === null ? null : judgement !== 'as_prescribed', fail);
      } else if (payload.missingMappings.length === 0) {
        add('PAYLOAD_INVALID', 'no MedicationDispense was built, yet no mapping is missing');
      }
      break;
    }
  }
  return violations.sort((a, b) => RULE_ORDER.indexOf(a.code) - RULE_ORDER.indexOf(b.code));
}
