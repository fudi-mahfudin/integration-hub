/** The case and step state machine of #8, as pure functions over a case's steps. */
import type { Brand } from '../brand.js';

/** The hub's id for a case. */
export type CaseId = Brand<string, 'CaseId'>;

/** The source system's own visit number; unique per source system (#6). */
export type VisitId = Brand<string, 'VisitId'>;

/** The four source event types, 1:1 with the steps (#6). */
export const EVENT_TYPES = ['visit.started', 'prescription.written', 'drug.dispensed', 'visit.finished'] as const;

/** A source event type. */
export type EventType = (typeof EVENT_TYPES)[number];

/** The four steps in order, each released by its own event type (#6). `seq` is the step's position. */
export const STEPS = [
  { seq: 1, name: 'create_visit', eventType: 'visit.started' },
  { seq: 2, name: 'submit_prescription', eventType: 'prescription.written' },
  { seq: 3, name: 'submit_dispense', eventType: 'drug.dispensed' },
  { seq: 4, name: 'update_visit', eventType: 'visit.finished' },
] as const satisfies readonly { seq: number; name: string; eventType: EventType }[];

/** A step's name. */
export type StepName = (typeof STEPS)[number]['name'];

/** The seven step states of #8. */
export type StepState =
  | 'awaiting_event'
  | 'blocked'
  | 'ready'
  | 'in_flight'
  | 'retry_wait'
  | 'completed'
  | 'dead_lettered';

/** A case's status: derived from its current step, except the operator-only `abandoned` (ADR 0007). */
export type CaseStatus = 'waiting' | 'active' | 'dead_lettered' | 'completed' | 'abandoned';

/**
 * Why a step was dead-lettered: a stable code on the step (#8, #10).
 * `REMOTE_RECORD_AMBIGUOUS`: search-then-create found more than one record
 * under the step's business identifier (ADR 0005).
 */
export type DeadLetterReason = 'MAPPING_MISSING' | 'PATIENT_NOT_FOUND' | 'PRACTITIONER_NOT_FOUND' | 'REMOTE_RECORD_AMBIGUOUS';

/** A step's position and state: all the state machine looks at. */
export interface StepView {
  seq: number;
  state: StepState;
}

/** The steps of a case just opened: all four exist at once, none has its event yet (#8). */
export function openingSteps(): StepView[] {
  return STEPS.map((s) => ({ seq: s.seq, state: 'awaiting_event' }));
}

/** The step a source event of `type` releases. */
export function stepForEvent(type: EventType): (typeof STEPS)[number] {
  const step = STEPS.find((s) => s.eventType === type);
  if (!step) throw new Error(`no step for event type "${type}"`);
  return step;
}

/**
 * Applies the arrival of the source event for step `seq` (#8): if that step is
 * the current step and awaiting its event it becomes `ready`, otherwise `blocked`.
 */
export function applyEventArrival(steps: readonly StepView[], seq: number): StepView[] {
  const current = currentStep(steps);
  return steps.map((s): StepView => {
    if (s.seq !== seq) return s;
    if (s.state !== 'awaiting_event') {
      throw new Error(`invariant broken: an event arrived for step ${seq}, which is ${s.state}, not awaiting_event`);
    }
    return { seq, state: current?.seq === seq ? 'ready' : 'blocked' };
  });
}

/**
 * Applies the completion of step `seq`, the current step (#8): it becomes
 * `completed`, and the next step becomes `ready` if its event is already
 * stored (`blocked`); otherwise it stays `awaiting_event` and the case waits.
 */
export function applyCompletion(steps: readonly StepView[], seq: number): StepView[] {
  const current = currentStep(steps);
  if (current?.seq !== seq || current.state !== 'in_flight') {
    throw new Error(`invariant broken: step ${seq} completed, but the current step is ${current?.seq}:${current?.state}`);
  }
  return steps.map((s): StepView => {
    if (s.seq === seq) return { seq, state: 'completed' };
    if (s.seq === seq + 1 && s.state === 'blocked') return { seq: s.seq, state: 'ready' };
    return s;
  });
}

/** The event a waiting case waits for: the current step's, if it has not arrived; otherwise `null`. */
export function waitingFor(steps: readonly StepView[]): EventType | null {
  const current = currentStep(steps);
  if (current?.state !== 'awaiting_event') return null;
  const step = STEPS.find((s) => s.seq === current.seq);
  if (!step) throw new Error(`no step ${current.seq}`);
  return step.eventType;
}

/** Case status from the current step, the earliest non-completed one (#8). */
export function deriveStatus(steps: readonly StepView[]): Exclude<CaseStatus, 'abandoned'> {
  const current = currentStep(steps);
  if (!current) return 'completed';
  switch (current.state) {
    case 'awaiting_event':
      return 'waiting';
    case 'dead_lettered':
      return 'dead_lettered';
    case 'ready':
    case 'in_flight':
    case 'retry_wait':
      return 'active';
    case 'blocked':
    case 'completed':
      throw new Error(`invariant broken: the current step ${current.seq} is ${current.state}`);
  }
}

function currentStep(steps: readonly StepView[]): StepView | undefined {
  return [...steps].sort((a, b) => a.seq - b.seq).find((s) => s.state !== 'completed');
}
