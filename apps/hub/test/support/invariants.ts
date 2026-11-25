import { expect } from 'vitest';

/** Step states that ADR 0004 allows at most once per case. */
const IN_MOTION = ['ready', 'in_flight', 'retry_wait', 'dead_lettered'];

/**
 * ADR 0004 as a testable check (#8): at most one step per case is in
 * {`ready`, `in_flight`, `retry_wait`, `dead_lettered`}. Pass any case view
 * read through `GET /v1/cases/{id}`.
 */
export function expectAtMostOneStepInMotion(caseView: { steps: { step: string; state: string }[] }): void {
  const moving = caseView.steps.filter((s) => IN_MOTION.includes(s.state)).map((s) => `${s.step}:${s.state}`);
  expect(moving.length, `ADR 0004: more than one step in motion: ${moving.join(', ')}`).toBeLessThanOrEqual(1);
}
