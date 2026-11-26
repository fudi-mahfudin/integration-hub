import type { DeadLetterReason } from '../cases/case-model.js';
import type { StepRemote } from '../outbox/outbox.js';

/** How an attempt at a step ended: with the record it stored at SATUSEHAT, or permanently failed. */
export type StepOutcome = { completed: StepRemote } | { deadLettered: DeadLetterReason };
