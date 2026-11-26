import type { DeadLetterReason, RemoteIdentifier } from '../cases/case-model.js';

/** How an attempt at a step ended: with the record it stored at SATUSEHAT, or permanently failed. */
export type StepOutcome = { completed: RemoteIdentifier } | { deadLettered: DeadLetterReason };
