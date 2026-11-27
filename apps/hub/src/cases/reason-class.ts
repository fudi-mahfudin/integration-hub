import type { DeadLetterReason } from './case-model.js';

/**
 * What an operator can do about a dead-lettered case (#21): `replayable`
 * when fixing something outside the case (a mapping, credentials, the
 * platform, a hub bug) and then replaying can complete it; `source_data`
 * when the immutable source events themselves are the problem, so abandoning
 * is suggested. Replay is never refused because of it.
 */
export type ReasonClass = 'replayable' | 'source_data';

/**
 * The class of every dead-letter reason, as #21 completed the table. The
 * three `*_AMBIGUOUS` reasons are not in it, and are classed here:
 * `REMOTE_RECORD_AMBIGUOUS` is `replayable` (duplicates at SATUSEHAT can be
 * cleaned up there); `PATIENT_AMBIGUOUS` and `PRACTITIONER_AMBIGUOUS` are
 * `source_data`, since the event's person data will find the same people again.
 */
const REASON_CLASSES: Record<DeadLetterReason, ReasonClass> = {
  MAPPING_MISSING: 'replayable',
  KFA_LEVEL_INVALID: 'replayable',
  RETRIES_EXHAUSTED: 'replayable',
  PLATFORM_FORBIDDEN: 'replayable',
  PATIENT_NOT_FOUND: 'replayable',
  PRACTITIONER_NOT_FOUND: 'replayable',
  PAYLOAD_INVALID: 'replayable',
  REMOTE_RECORD_MISSING: 'replayable',
  REMOTE_RECORD_AMBIGUOUS: 'replayable',
  UNSUPPORTED_THERAPEUTIC_SUBSTITUTION: 'source_data',
  SUBSTITUTION_MISMATCH: 'source_data',
  PATIENT_AMBIGUOUS: 'source_data',
  PRACTITIONER_AMBIGUOUS: 'source_data',
};

/** The class of a dead-letter reason. */
export function reasonClassOf(reason: DeadLetterReason): ReasonClass {
  return REASON_CLASSES[reason];
}

/** Whether `code` is a dead-letter reason. */
export function isDeadLetterReason(code: string): code is DeadLetterReason {
  return Object.hasOwn(REASON_CLASSES, code);
}
