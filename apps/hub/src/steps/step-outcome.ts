import type { DeadLetterReason, RemoteIdentifier } from '../cases/case-model.js';
import type { CreateVisitPins, StepPins, SubmitDispensePins, SubmitPrescriptionPins, UpdateVisitPins } from '../cases/pins.js';
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
  /** The resolved values the attempt used, as far as it got: the values its step pins once it completes. */
  valuesUsed: Partial<CreateVisitPins> | Partial<SubmitPrescriptionPins> | Partial<SubmitDispensePins> | Partial<UpdateVisitPins>;
  /** How each person it looked up was found. */
  lookupMethods: { patient?: LookupMethod; practitioner?: LookupMethod; requester?: LookupMethod; pharmacist?: LookupMethod };
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

/**
 * An attempt that ended without an outcome (a request failed, a lookup could
 * not be resolved), carrying what it had resolved so the attempt log keeps it (#10).
 */
export class AttemptFailed extends Error {
  constructor(
    readonly facts: AttemptFacts,
    options: { cause: unknown },
  ) {
    const resolved = Object.keys(facts.valuesUsed).join(', ') || 'nothing';
    super(`the attempt failed after resolving ${resolved}: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`, options);
    this.name = 'AttemptFailed';
  }
}

/** Dead-letters a payload the Validation module rejected, with its first violation in rule order. */
export function rejected(attempt: AttemptFacts): StepOutcome {
  const [first] = attempt.violations;
  if (!first) throw new Error('rejected() needs at least one violation');
  return { deadLettered: first.code, attempt };
}
