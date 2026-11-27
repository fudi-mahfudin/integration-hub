// The expected-outcome manifest: written before the first send, it fixes what
// every check is judged against.
import type { Plan } from '@integration-hub/simulator';
import { createHash } from 'node:crypto';
import type { Override, RunKind } from './settings.js';
import type { BigRunCommitments } from './settings.js';

/** The four effects, in order, every visit must leave at SATUSEHAT. */
export const EXPECTED_EFFECTS = ['Encounter created', 'MedicationRequest created', 'MedicationDispense created', 'Encounter updated'] as const;

/** A planned visit and what it must leave at SATUSEHAT. */
export interface ManifestVisit {
  visitId: string;
  scenario: 'as_prescribed' | 'substitution';
  lookupMethod: string;
  outOfOrder: boolean;
  patientIhsNumber: string;
  prescribedKfaCode: string;
  dispensedKfaCode: string;
  expectedEffects: readonly string[];
}

/** A planned original send. The body is fixed by its hash, so a duplicate's byte-identity can be shown without storing it. */
export interface ManifestSend {
  visitId: string;
  eventType: string;
  idempotencyKey: string;
  atMs: number;
  /** `concurrent`, `delayed` (with `afterAcceptMs`), `late`, or null. */
  duplicate: { kind: string; afterAcceptMs?: number } | null;
  bodySha256: string;
}

/** The manifest: what the run will send and what it must show, fixed before any send. */
export interface Manifest {
  writtenAt: string;
  kind: RunKind;
  runId: string;
  /** The commitments the run is judged by, after CI scaling and overrides. */
  bigRun: BigRunCommitments;
  overrides: Override[];
  /** What PASS requires, in counts. */
  expected: {
    originals: number;
    duplicates: number;
    completedCases: number;
    completedSteps: number;
  };
  visits: ManifestVisit[];
  sends: ManifestSend[];
}

/** The manifest of a planned batch. */
export function manifestFor(plan: Plan, run: { kind: RunKind; bigRun: BigRunCommitments; overrides: Override[] }, writtenAt: Date): Manifest {
  return {
    writtenAt: writtenAt.toISOString(),
    kind: run.kind,
    runId: plan.options.runId,
    bigRun: run.bigRun,
    overrides: run.overrides,
    expected: {
      originals: plan.sends.length,
      duplicates: plan.sends.filter((s) => s.duplicate !== null).length,
      completedCases: run.bigRun.invariants.hubSide.completedCases,
      completedSteps: run.bigRun.invariants.hubSide.completedSteps,
    },
    visits: plan.visits.map((visit) => ({ ...visit, expectedEffects: EXPECTED_EFFECTS })),
    sends: plan.sends.map((send) => ({
      visitId: send.visitId,
      eventType: send.eventType,
      idempotencyKey: send.idempotencyKey,
      atMs: send.atMs,
      duplicate: send.duplicate,
      bodySha256: createHash('sha256').update(send.body).digest('hex'),
    })),
  };
}
