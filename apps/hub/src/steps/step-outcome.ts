import type { DeadLetterReason, RemoteIdentifier, StepName } from '../cases/case-model.js';
import type { CreateVisitPins, StepPins, SubmitDispensePins, SubmitPrescriptionPins, UpdateVisitPins } from '../cases/pins.js';
import type { Violation } from '../validation/validation.js';

/** How a person's IHS number was found (#10, #32): by NIK, or by one of the fallbacks SATUSEHAT documents. */
export type LookupMethod = 'nik' | 'mother_nik_birth_date' | 'name_birth_date_gender';

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
 * How an attempt at a step ended for good: with the record it stored at
 * SATUSEHAT and the values it pins, or permanently failed; either way with
 * its attempt facts.
 */
export type FinalOutcome =
  | { completed: RemoteIdentifier; pins: StepPins; attempt: AttemptFacts }
  | { deadLettered: DeadLetterReason; attempt: AttemptFacts };

/**
 * A remote identifier an earlier step stored is stale (#10): SATUSEHAT no
 * longer holds it, and a search by the business identifier found exactly one
 * record, `now`. The stored id is refreshed to it (the old one, `was`, is
 * logged) and the attempt ends transient.
 */
export interface StaleRemote {
  /** The step that stored the identifier. */
  step: StepName;
  /** The stored identifier SATUSEHAT no longer holds. */
  was: RemoteIdentifier;
  /** The one record the search found. */
  now: RemoteIdentifier;
}

/** How an attempt at a step ended: for good, or on a stale remote identifier, which is retried. */
export type StepOutcome = FinalOutcome | { staleRemote: StaleRemote; attempt: AttemptFacts };

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
export function rejected(attempt: AttemptFacts): FinalOutcome {
  const [first] = attempt.violations;
  if (!first) throw new Error('rejected() needs at least one violation');
  return { deadLettered: first.code, attempt };
}
