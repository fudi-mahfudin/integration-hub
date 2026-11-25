/** The case and step state machine of #8, as pure functions over a case's steps. */

export const EVENT_TYPES = ['visit.started', 'prescription.written', 'drug.dispensed', 'visit.finished'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The four steps in order, 1:1 with event types (#6). `seq` is the step's position. */
export const STEPS = [
  { seq: 1, name: 'create_visit', eventType: 'visit.started' },
  { seq: 2, name: 'submit_prescription', eventType: 'prescription.written' },
  { seq: 3, name: 'submit_dispense', eventType: 'drug.dispensed' },
  { seq: 4, name: 'update_visit', eventType: 'visit.finished' },
] as const satisfies readonly { seq: number; name: string; eventType: EventType }[];

export type StepState =
  | 'awaiting_event'
  | 'blocked'
  | 'ready'
  | 'in_flight'
  | 'retry_wait'
  | 'completed'
  | 'dead_lettered';

export type CaseStatus = 'waiting' | 'active' | 'dead_lettered' | 'completed' | 'abandoned';

export interface StepView {
  seq: number;
  state: StepState;
}

/** The state of every step of a case that has just been opened (#8: all four rows exist at once). */
export function openingSteps(): StepView[] {
  return STEPS.map((s) => ({ seq: s.seq, state: 'awaiting_event' }));
}

/** The current step: the earliest non-completed one, or undefined when all are completed. */
export function currentStep(steps: readonly StepView[]): StepView | undefined {
  return [...steps].sort((a, b) => a.seq - b.seq).find((s) => s.state !== 'completed');
}

/**
 * Applies the arrival of the source event for step `seq`: if it is the current
 * step and still awaiting its event it becomes `ready`, otherwise `blocked`.
 */
export function applyEventArrival(steps: readonly StepView[], seq: number): StepView[] {
  const current = currentStep(steps);
  return steps.map((s) => {
    if (s.seq !== seq) return s;
    const isCurrent = current?.seq === seq && s.state === 'awaiting_event';
    return { seq, state: isCurrent ? 'ready' : 'blocked' };
  });
}

export interface DerivedStatus {
  status: Exclude<CaseStatus, 'abandoned'>;
  /** The event type of the earliest missing event, when `waiting`. */
  waitingFor: EventType | null;
}

/** Case status from the current step (#8). The current step is never `blocked`. */
export function deriveStatus(steps: readonly StepView[]): DerivedStatus {
  const current = currentStep(steps);
  if (!current) return { status: 'completed', waitingFor: null };
  switch (current.state) {
    case 'awaiting_event':
      return { status: 'waiting', waitingFor: stepBySeq(current.seq).eventType };
    case 'dead_lettered':
      return { status: 'dead_lettered', waitingFor: null };
    case 'ready':
    case 'in_flight':
    case 'retry_wait':
      return { status: 'active', waitingFor: null };
    default:
      throw new Error(`invariant broken: current step ${current.seq} is ${current.state}`);
  }
}

export function stepBySeq(seq: number) {
  const step = STEPS.find((s) => s.seq === seq);
  if (!step) throw new Error(`no step ${seq}`);
  return step;
}

export function stepForEvent(type: EventType) {
  return STEPS.find((s) => s.eventType === type) as (typeof STEPS)[number];
}
