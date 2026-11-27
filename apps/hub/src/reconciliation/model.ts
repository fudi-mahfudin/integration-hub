/**
 * Reconciliation's model (#39): what a case at rest expects to find at
 * SATUSEHAT, and the divergences between that and what a search found, as
 * pure functions.
 */
import type { RemoteIdentifier, StepName } from '../cases/case-model.js';
import type { RecordAtSatusehat } from '../satusehat/client.js';

/** How a reconciliation run stands: waiting for a worker, executing, or ended. */
export type ReconciliationRunStatus = 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

/** The statuses of a run that has ended: a run in one of them never changes again. */
export const ENDED_RUN_STATUSES = ['completed', 'completed_with_errors', 'failed'] as const satisfies readonly ReconciliationRunStatus[];

/** The statuses of a run whose checks count: it went through its whole scope. */
export const COMPLETED_RUN_STATUSES = ['completed', 'completed_with_errors'] as const satisfies readonly ReconciliationRunStatus[];

/**
 * How one case's check ended: `clean` (nothing differs), `divergent`, `skipped`
 * (the case changed during its check, so no comparison is reported) or
 * `unchecked` (a search still failed after its read retries, or a breaker was open).
 */
export type ReconciliationCheckOutcome = 'clean' | 'divergent' | 'skipped' | 'unchecked';

/** Every divergence class, for code that must cover them all (the `reconciliation_divergences` gauge). */
export const DIVERGENCE_CLASSES = ['REMOTE_MISSING', 'REMOTE_UNEXPECTED', 'REMOTE_DUPLICATE', 'REMOTE_ID_MISMATCH', 'FIELD_MISMATCH'] as const;

/**
 * The kinds of divergence (#39). `REMOTE_MISSING`: a completed step's record
 * is not found. `REMOTE_UNEXPECTED`: a record is found for a step that is not
 * completed. `REMOTE_DUPLICATE`: a completed step's identifier finds more than
 * one record. `REMOTE_ID_MISMATCH`: it finds one record, but not the one the
 * step stored. `FIELD_MISMATCH`: the stored record holds another value in a
 * compared field.
 */
export type DivergenceClass = (typeof DIVERGENCE_CLASSES)[number];

/** Fields that hold a person's IHS number: a finding says only that they differ, never their values. */
const IHS_FIELDS = new Set(['subject', 'participant.individual', 'requester', 'performer.actor']);

/** What one resource of a case should look like at SATUSEHAT: the record its completed step stored, and its compared fields. */
export interface ExpectedRecord {
  /** The step that created the record. */
  step: StepName;
  remote: RemoteIdentifier;
  /** The compared fields by FHIR path, each the value the step sent. */
  fields: Record<string, string>;
  /** Which step a mismatch of a field is held against, when not `step` (an Encounter's update visit). */
  fieldSteps: Record<string, StepName>;
  /** `meta.versionId` as the hub stored it last, and the step that stored it; null when SATUSEHAT sent none. */
  version: { value: string; step: StepName } | null;
}

/** One divergence of one resource of a case. */
export interface Divergence {
  class: DivergenceClass;
  step: StepName;
  resourceType: RemoteIdentifier['type'];
  /** The field that differs, by FHIR path, for a `FIELD_MISMATCH`; null otherwise. */
  field: string | null;
  /** What was expected and found; for a person's IHS number only `{ differs: true }`. */
  snapshot: Record<string, unknown>;
}

/** One resource of a case to compare: the step that would create it, what it expects (null: no record), and what the search found. */
export interface ResourceComparison {
  resourceType: RemoteIdentifier['type'];
  /** The step whose record this is: completed, it expects one; in any other state, none (ADR 0007). */
  step: StepName;
  expected: ExpectedRecord | null;
  found: readonly RecordAtSatusehat[];
}

const remoteOf = (record: RecordAtSatusehat): RemoteIdentifier => record.remote;

/**
 * The divergences of one resource of a case (#39): a completed step's
 * identifier finds exactly the record it stored, with the values it sent and
 * the `meta.versionId` the hub stored last; any other step's finds none.
 */
export function compareResource(comparison: ResourceComparison): Divergence[] {
  const { resourceType, step: creatingStep, expected, found } = comparison;
  const divergence = (cls: DivergenceClass, step: StepName, field: string | null, snapshot: Record<string, unknown>): Divergence => ({
    class: cls,
    step,
    resourceType,
    field,
    snapshot,
  });
  if (!expected) return found.length === 0 ? [] : [divergence('REMOTE_UNEXPECTED', creatingStep, null, { expected: null, found: found.map(remoteOf) })];
  const [only] = found;
  if (!only) return [divergence('REMOTE_MISSING', expected.step, null, { expected: expected.remote, found: [] })];
  if (found.length > 1) return [divergence('REMOTE_DUPLICATE', expected.step, null, { expected: expected.remote, found: found.map(remoteOf) })];
  if (only.remote.id !== expected.remote.id) {
    return [divergence('REMOTE_ID_MISMATCH', expected.step, null, { expected: expected.remote, found: [only.remote] })];
  }

  const mismatches: Divergence[] = [];
  for (const [field, value] of Object.entries(expected.fields)) {
    const actual = only.fields[field] ?? null;
    if (actual === value) continue;
    const step = expected.fieldSteps[field] ?? expected.step;
    mismatches.push(divergence('FIELD_MISMATCH', step, field, IHS_FIELDS.has(field) ? { differs: true } : { expected: value, actual }));
  }
  if (expected.version && only.remote.version !== expected.version.value) {
    mismatches.push(divergence('FIELD_MISMATCH', expected.version.step, 'meta.versionId', { expected: expected.version.value, actual: only.remote.version }));
  }
  return mismatches;
}
