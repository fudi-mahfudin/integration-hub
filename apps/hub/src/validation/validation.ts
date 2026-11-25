/**
 * The Validation module (#9, #28): the step-time check of what a step is
 * about to send. Pure: what the step resolved and built goes in, violations
 * come out, ordered by rule. A violation is permanent: the step dead-letters
 * with the first violation's code and every violation goes to the attempt log.
 *
 * Written from #9's rule text, never from the mock's rules (ADR 0006).
 */
import { encounterRules } from './encounter-rules.js';
import { medicationDispenseRules } from './medication-dispense-rules.js';
import { medicationRequestRules } from './medication-request-rules.js';

/** Step dead-letter codes, in rule order (#9). */
export const RULE_ORDER = [
  'MAPPING_MISSING',
  'KFA_LEVEL_INVALID',
  'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
  'SUBSTITUTION_MISMATCH',
  'PAYLOAD_INVALID',
] as const;
export type RuleCode = (typeof RULE_ORDER)[number];

export interface Violation {
  code: RuleCode;
  /** FHIRPath-like path into the payload (`Encounter.period.start`); `''` when not about the payload. */
  path: string;
  message: string;
  /** `PAYLOAD_INVALID` only: which payload rule (REQUIRED, TIME_FORMAT, DATE_FLOOR, IDENTIFIER_SYSTEM, VALUE_SET, REFERENCE, ...). */
  rule?: string;
  /** `MAPPING_MISSING` only: what the operator must add (the dashboard's inline fix, #21). */
  mapping?: { kind: MappingKind; localCode: string };
}

export type MappingKind = 'location' | 'drug';

/** One operator mapping a step looked up (#10). */
export interface MappingUse {
  kind: MappingKind;
  localCode: string;
  found: boolean;
  /** Why it is missing, when not simply absent (e.g. KFA does not know the mapped code). */
  message?: string;
}

/** A KFA product as the drug mapping and KFA details provide it (#9, #10). */
export interface KfaProduct {
  code: string;
  /** 91 ingredient, 92 product template, 93 product. */
  level: number;
  /** For a 93: its 92. */
  parent92: string | null;
  /** The set of active-ingredient (91) codes. */
  ingredients: readonly string[];
}

export type MedicationUse =
  | { role: 'prescription'; product: KfaProduct }
  | {
      role: 'dispense';
      product: KfaProduct;
      /** The product the prescription step pinned, never the live mapping (#10). */
      prescribed: KfaProduct;
      /** Whether the source declared a substitution (`drug.dispensed.substitution`). */
      declaredSubstitution: boolean;
    };

/** A FHIR resource as the step built it. */
export type FhirPayload = { resourceType?: unknown; [field: string]: unknown };

/** What a step is about to send. Pass what applies; omit `resource` when a missing mapping left nothing to build. */
export interface StepCheck {
  /** The source's organization: the `{org}` in every identifier system. */
  organizationId: string;
  mappings?: MappingUse[];
  medication?: MedicationUse;
  resource?: FhirPayload;
}

/** Payload rules per resource type; #31 adds the Encounter update. */
const PAYLOAD_RULES: Record<string, (resource: FhirPayload, organizationId: string) => Violation[]> = {
  Encounter: encounterRules,
  MedicationRequest: medicationRequestRules,
  MedicationDispense: medicationDispenseRules,
};

/** Every violation of `check`, ordered by rule (stable within a rule). */
export function validateStep(check: StepCheck): Violation[] {
  const out: Violation[] = [];
  for (const m of check.mappings ?? []) {
    if (!m.found) {
      out.push({
        code: 'MAPPING_MISSING',
        path: '',
        message: m.message ?? `no ${m.kind} mapping for local code ${m.localCode}`,
        mapping: { kind: m.kind, localCode: m.localCode },
      });
    }
  }
  if (check.medication) out.push(...medicationRules(check.medication));
  if (check.resource) {
    const type = String(check.resource.resourceType);
    const rules = PAYLOAD_RULES[type];
    out.push(
      ...(rules
        ? rules(check.resource, check.organizationId)
        : [{ code: 'PAYLOAD_INVALID' as const, rule: 'RESOURCE_TYPE', path: 'resourceType', message: `no payload rules for ${type}` }]),
    );
  }
  return out.sort((a, b) => RULE_ORDER.indexOf(a.code) - RULE_ORDER.indexOf(b.code));
}

/** The dead-letter reason: the first violation in rule order, or undefined when there is none. */
export function deadLetterReason(violations: readonly Violation[]): RuleCode | undefined {
  let best: RuleCode | undefined;
  for (const v of violations) if (best === undefined || RULE_ORDER.indexOf(v.code) < RULE_ORDER.indexOf(best)) best = v.code;
  return best;
}

function medicationRules(m: MedicationUse): Violation[] {
  // A prescription maps to 92 or 93, a dispense to 93 (#9).
  const allowed = m.role === 'prescription' ? [92, 93] : [93];
  if (!allowed.includes(m.product.level)) {
    return [
      {
        code: 'KFA_LEVEL_INVALID',
        path: '',
        message: `a ${m.role} needs KFA level ${allowed.join(' or ')}; ${m.product.code} is level ${m.product.level}`,
      },
    ];
  }
  if (m.role === 'prescription') return [];

  const { product, prescribed } = m;
  const kind = substitutionKind(product, prescribed);
  if (kind === 'therapeutic') {
    return [
      {
        code: 'UNSUPPORTED_THERAPEUTIC_SUBSTITUTION',
        path: '',
        message: `${product.code} does not have the active ingredients of the prescribed ${prescribed.code}`,
      },
    ];
  }
  const substituted = kind === 'substitution';
  if (substituted !== m.declaredSubstitution) {
    return [
      {
        code: 'SUBSTITUTION_MISMATCH',
        path: '',
        message: substituted
          ? `${product.code} substitutes the prescribed ${prescribed.code} but the source declared no substitution`
          : `the source declared a substitution but ${product.code} is the prescribed ${prescribed.code}`,
      },
    ];
  }
  return [];
}

/**
 * What a dispensed 93 is against the prescribed product (#9): the prescribed
 * 93 or a child of the prescribed 92 is `as_prescribed`; otherwise an equal
 * 91 set is a `substitution` (strength change or brand swap); any other 91
 * set is `therapeutic` (unsupported). Submit dispense sets `wasSubstituted`
 * from this, the medication rule checks the source's declaration against it.
 */
export function substitutionKind(product: KfaProduct, prescribed: KfaProduct): 'as_prescribed' | 'substitution' | 'therapeutic' {
  const asPrescribed =
    prescribed.level === 93 ? product.code === prescribed.code : product.parent92 !== null && product.parent92 === prescribed.code;
  if (asPrescribed) return 'as_prescribed';
  return sameSet(product.ingredients, prescribed.ingredients) ? 'substitution' : 'therapeutic';
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}
