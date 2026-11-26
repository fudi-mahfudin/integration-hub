import type { DeadLetterReason, RemoteIdentifier } from '../cases/case-model.js';
import type { StepPins } from '../cases/pins.js';
import type { Violation } from '../validation/validation.js';

/** How a person's IHS number was found (#10, #32). Only by NIK so far. */
export type LookupMethod = 'nik';

/**
 * What one attempt used and saw, for its row in the attempt log (#8, #10).
 * A failed attempt records what it had resolved before it stopped.
 */
export interface AttemptFacts {
  /** The status of the last SATUSEHAT response the attempt read; null when it sent nothing. */
  httpStatus: number | null;
  /** The resolved values the attempt used, as far as it got. */
  valuesUsed: Partial<StepPins>;
  /** How each person it looked up was found. */
  lookupMethods: { patient?: LookupMethod; practitioner?: LookupMethod };
  /** Every violation the Validation module found; empty when the payload passed or was never checked. */
  violations: readonly Violation[];
}

/**
 * How an attempt at a step ended: with the record it stored at SATUSEHAT and
 * the values it pins, or permanently failed; either way with its attempt facts.
 */
export type StepOutcome =
  | { completed: RemoteIdentifier; pins: StepPins; attempt: AttemptFacts }
  | { deadLettered: DeadLetterReason; attempt: AttemptFacts };
