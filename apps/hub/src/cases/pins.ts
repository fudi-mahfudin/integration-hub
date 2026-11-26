import { z } from 'zod';
import { parseKfaProduct, type KfaCode, type KfaProduct } from '../kfa/kfa-product.js';
import type { IhsNumber, LocationId } from '../satusehat/client.js';
import type { StepName } from './case-model.js';

/**
 * What a completed create visit sent, pinned in the transaction that stored
 * its remote identifier (#10). Later steps read these, never the live
 * mappings or lookups, so the whole case describes one patient, practitioner
 * and Location.
 */
export interface CreateVisitPins {
  patientIhsNumber: IhsNumber;
  practitionerIhsNumber: IhsNumber;
  locationId: LocationId;
}

/** A KFA product a drug step sent, as the KFA rules judge it (#9, #10). */
export interface KfaProductPins {
  kfaCode: KfaCode;
  kfaLevel: number;
  /** For an actual product (93), its virtual product; otherwise null. */
  parent92: KfaCode | null;
  /** The 91 codes of its active ingredients. */
  activeIngredients: KfaCode[];
}

/**
 * What a completed submit prescription sent (#10): the prescribed KFA product
 * and the requester. The dispense step compares its product against these,
 * never the live drug mapping.
 */
export interface SubmitPrescriptionPins extends KfaProductPins {
  requesterIhsNumber: IhsNumber;
}

/** What a completed submit dispense sent (#30): the dispensed KFA product and the pharmacist. */
export interface SubmitDispensePins extends KfaProductPins {
  pharmacistIhsNumber: IhsNumber;
}

/** A step's pins. */
export type StepPins = CreateVisitPins | SubmitPrescriptionPins | SubmitDispensePins;

const createVisitPinsSchema = z.object({
  patientIhsNumber: z.string().min(1),
  practitionerIhsNumber: z.string().min(1),
  locationId: z.string().min(1),
});

/**
 * Reads a step's stored pins back, by the step that wrote them.
 * @throws Error when the stored value does not match that step's pins.
 */
export function readPins(step: StepName, stored: unknown): StepPins {
  switch (step) {
    case 'create_visit':
      return readCreateVisitPins(stored);
    case 'submit_prescription':
      return readSubmitPrescriptionPins(stored);
    case 'submit_dispense':
      return readSubmitDispensePins(stored);
    case 'update_visit':
      throw new Error(`step ${step} has no pins defined yet, but its row holds ${stored === null ? 'null' : 'a value'}`);
  }
}

/**
 * Reads a create visit's stored pins back.
 * @throws Error when the stored value is not create visit pins, which means the row was changed outside the hub.
 */
export function readCreateVisitPins(stored: unknown): CreateVisitPins {
  const parsed = createVisitPinsSchema.safeParse(stored);
  // The fields only: the stored values are IHS numbers, which no message carries.
  if (!parsed.success) throw new Error(`stored create visit pins do not match their schema at ${pinProblems(parsed.error)}`);
  const { patientIhsNumber, practitionerIhsNumber, locationId } = parsed.data;
  // Written only by lease-fenced completion, from the IHS numbers and Location ID create visit sent.
  return { patientIhsNumber: patientIhsNumber as IhsNumber, practitionerIhsNumber: practitionerIhsNumber as IhsNumber, locationId: locationId as LocationId };
}

const kfaProductPinsSchema = z.object({
  kfaCode: z.string(),
  kfaLevel: z.number().int(),
  parent92: z.string().nullable(),
  activeIngredients: z.array(z.string()),
});
const submitPrescriptionPinsSchema = kfaProductPinsSchema.extend({ requesterIhsNumber: z.string().min(1) });
const submitDispensePinsSchema = kfaProductPinsSchema.extend({ pharmacistIhsNumber: z.string().min(1) });

/**
 * Reads a submit prescription's stored pins back.
 * @throws Error when the stored value is not submit prescription pins, which means the row was changed outside the hub.
 */
export function readSubmitPrescriptionPins(stored: unknown): SubmitPrescriptionPins {
  const parsed = submitPrescriptionPinsSchema.safeParse(stored);
  if (!parsed.success) throw new Error(`stored submit prescription pins do not match their schema at ${pinProblems(parsed.error)}`);
  const { kfaCode, kfaLevel, parent92, activeIngredients, requesterIhsNumber } = parsed.data;
  return {
    ...kfaProductPins(parseKfaProduct({ code: kfaCode, level: kfaLevel, parent92, activeIngredients })),
    // Written only by lease-fenced completion, from the requester's IHS number the step sent.
    requesterIhsNumber: requesterIhsNumber as IhsNumber,
  };
}

/**
 * Reads a submit dispense's stored pins back.
 * @throws Error when the stored value is not submit dispense pins, which means the row was changed outside the hub.
 */
export function readSubmitDispensePins(stored: unknown): SubmitDispensePins {
  const parsed = submitDispensePinsSchema.safeParse(stored);
  if (!parsed.success) throw new Error(`stored submit dispense pins do not match their schema at ${pinProblems(parsed.error)}`);
  const { kfaCode, kfaLevel, parent92, activeIngredients, pharmacistIhsNumber } = parsed.data;
  return {
    ...kfaProductPins(parseKfaProduct({ code: kfaCode, level: kfaLevel, parent92, activeIngredients })),
    // Written only by lease-fenced completion, from the pharmacist's IHS number the step sent.
    pharmacistIhsNumber: pharmacistIhsNumber as IhsNumber,
  };
}

/** Where stored pins broke their schema, by field path only. */
function pinProblems(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
}

/** The pin fields of a KFA product a drug step sent. */
export function kfaProductPins(product: KfaProduct): KfaProductPins {
  return { kfaCode: product.code, kfaLevel: product.level, parent92: product.parent92, activeIngredients: [...product.activeIngredients] };
}
