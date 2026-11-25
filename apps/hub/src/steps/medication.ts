import { kfaProduct } from '../mapping/kfa-products.js';
import { findKfaCode } from '../mapping/mappings.js';
import type { KfaDetails } from '../satusehat/fhir-client.js';
import { DOSE_FORM_SYSTEM, KFA_SYSTEM, MEDICATION_TYPE_SYSTEM, MEDICATION_TYPE_URL, sysIdSystem } from '../satusehat/systems.js';
import type { KfaProduct, MappingUse } from '../validation/validation.js';
import { checkStep, type Attempt, type DeadLettered, type StepDeps } from './step-runner.js';

/** A local drug code resolved to its KFA product (#10). */
export interface ResolvedDrug {
  /** Everything KFA v2 says about it, for the payload. */
  details: KfaDetails;
  /** What the drug rules judge and the step pins. */
  product: KfaProduct;
  /** The drug mapping as found, for `checkStep`. */
  mappings: MappingUse[];
}

/**
 * Drug mapping → KFA (submit prescription and submit dispense): the source's
 * local drug code to its KFA code, then the KFA product (stored, else
 * fetched). Puts `used.drug` as soon as it knows it. A missing mapping, or
 * a mapped code KFA does not know, is the `MAPPING_MISSING` dead-letter.
 */
export async function resolveDrug(
  { db, kfa, clock }: StepDeps,
  step: { sourceId: string; organizationId: string },
  drugCode: string,
  { used }: Attempt,
): Promise<ResolvedDrug | DeadLettered> {
  const kfaCode = await findKfaCode(db, step.sourceId, drugCode);
  const drug: Record<string, unknown> = { localCode: drugCode, kfaCode: kfaCode ?? null };
  used.drug = drug;
  const missing = (message?: string): DeadLettered =>
    checkStep({ organizationId: step.organizationId, mappings: [{ kind: 'drug', localCode: drugCode, found: false, message }] }) as DeadLettered;
  if (kfaCode === undefined) return missing();
  const details = await kfaProduct(db, kfa, kfaCode, clock);
  if (details === undefined) return missing(`KFA does not know ${kfaCode}, the code local drug ${drugCode} maps to`);
  const product = productOf(details);
  drug.kfa = product;
  return { details, product, mappings: [{ kind: 'drug', localCode: drugCode, found: true }] };
}

/** The drug-rule view of KFA details. */
function productOf(d: KfaDetails): KfaProduct {
  return { code: d.code, level: d.level, parent92: d.parent92, ingredients: [...d.ingredients] };
}

/** A quantity's unit: the product's dose form (#6), or nothing when KFA gives none (the payload rules then fail it). */
export function doseFormUnit(details: KfaDetails): { unit: string; system: string; code: string } | Record<string, never> {
  return details.doseForm ? { unit: details.doseForm.name, system: DOSE_FORM_SYSTEM, code: details.doseForm.code } : {};
}

/**
 * The contained non-compound Medication `#medication` of a MedicationRequest
 * or MedicationDispense: `medication/{org}` identifier = the item id, the
 * KFA coding, the MedicationType `NC` extension, plus `extra` (a dispense's batch).
 */
export function containedMedication(
  details: KfaDetails,
  organizationId: string,
  itemId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    resourceType: 'Medication',
    id: 'medication',
    identifier: [{ system: sysIdSystem('medication', organizationId), use: 'official', value: itemId }],
    code: { coding: [{ system: KFA_SYSTEM, code: details.code, display: details.display }] },
    status: 'active',
    extension: [
      {
        url: MEDICATION_TYPE_URL,
        valueCodeableConcept: { coding: [{ system: MEDICATION_TYPE_SYSTEM, code: 'NC', display: 'Non-compound' }] },
      },
    ],
    ...extra,
  };
}

/** `prescription/{org}` and `prescription-item/{org}`, the identifiers MedicationRequest and MedicationDispense share (#9). */
export function prescriptionIdentifiers(organizationId: string, prescriptionId: string, itemId: string) {
  const identifier = { system: sysIdSystem('prescription', organizationId), value: prescriptionId };
  return {
    /** What search-then-create searches by. */
    identifier,
    identifiers: [
      { ...identifier, use: 'official' },
      { system: sysIdSystem('prescription-item', organizationId), use: 'official', value: itemId },
    ],
  };
}
