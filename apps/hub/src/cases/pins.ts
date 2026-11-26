import { z } from 'zod';
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

/** A step's pins. Only create visit pins so far; the drug steps add theirs (#29, #30). */
export type StepPins = CreateVisitPins;

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
    case 'submit_dispense':
    case 'update_visit':
      throw new Error(`step ${step} has no pins defined yet, but its row holds ${JSON.stringify(stored)}`);
  }
}

/**
 * Reads a create visit's stored pins back.
 * @throws Error when the stored value is not create visit pins, which means the row was changed outside the hub.
 */
export function readCreateVisitPins(stored: unknown): CreateVisitPins {
  const parsed = createVisitPinsSchema.safeParse(stored);
  if (!parsed.success) throw new Error(`stored create visit pins do not match their schema: ${JSON.stringify(stored)}`);
  const { patientIhsNumber, practitionerIhsNumber, locationId } = parsed.data;
  // Written only by lease-fenced completion, from the IHS numbers and Location ID create visit sent.
  return { patientIhsNumber: patientIhsNumber as IhsNumber, practitionerIhsNumber: practitionerIhsNumber as IhsNumber, locationId: locationId as LocationId };
}
