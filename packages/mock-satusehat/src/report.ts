import type { LogEntry } from './submission-log.js';

/** The order a visit's effects must land in at SATUSEHAT. */
const EXPECTED_ORDER = ['Encounter created', 'MedicationRequest created', 'MedicationDispense created', 'Encounter updated'] as const;

/**
 * A duplicate submission (GLOSSARY.md): more than one record created for one
 * business identifier, or more than one applied update of one record.
 */
export interface DuplicateSubmission {
  resourceType: string;
  /** Whether the repeated effect is a create or an update. */
  effect: 'created' | 'updated';
  businessIdentifier: string;
  visitKey: string | null;
  /** The `seq` of every such effect, oldest first. */
  seqs: number[];
}

/** An effect that landed before one of its predecessors, or after one of its successors. */
export interface OutOfOrderEffect {
  visitKey: string;
  seq: number;
  /** E.g. `MedicationRequest created`. */
  effect: string;
  /** What was wrong, e.g. `before "Encounter created"`. */
  reason: string;
}

/** Two requests for one visit that were in flight at the same time. */
export interface OverlappingRequests {
  visitKey: string;
  seqs: [number, number];
}

/** Invariant violations computed from the submission log; an empty report means every invariant held. */
export interface MockReport {
  /** Seed of the current fault rules, or null when none are set. */
  faultSeed: number | null;
  duplicates: DuplicateSubmission[];
  outOfOrder: OutOfOrderEffect[];
  overlap: OverlappingRequests[];
}

/** Computes the report from the whole log. Requests with `effect: none` never count as effects. */
export function computeReport(entries: readonly LogEntry[], faultSeed: number | null): MockReport {
  return {
    faultSeed,
    duplicates: findDuplicates(entries),
    outOfOrder: findOutOfOrder(entries),
    overlap: findOverlap(entries),
  };
}

function findDuplicates(entries: readonly LogEntry[]): DuplicateSubmission[] {
  const groups = new Map<string, DuplicateSubmission>();
  for (const e of entries) {
    const { effect } = e;
    if (effect === 'none' || e.resourceType === null || e.businessIdentifier === null) continue;
    const key = `${e.resourceType} ${effect} ${e.businessIdentifier}`;
    const group = groups.get(key) ?? { resourceType: e.resourceType, effect, businessIdentifier: e.businessIdentifier, visitKey: e.visitKey, seqs: [] };
    group.seqs.push(e.seq);
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.seqs.length > 1);
}

function findOutOfOrder(entries: readonly LogEntry[]): OutOfOrderEffect[] {
  const found: OutOfOrderEffect[] = [];
  for (const [visitKey, visitEntries] of byVisit(entries)) {
    const seen = new Set<number>();
    let furthest = -1;
    for (const e of visitEntries) {
      if (e.effect === 'none') continue;
      const effect = `${e.resourceType} ${e.effect}`;
      const step = EXPECTED_ORDER.findIndex((s) => s === effect);
      if (step === -1) continue;
      const missing = EXPECTED_ORDER.slice(0, step).find((_, i) => !seen.has(i));
      if (step < furthest) {
        found.push({ visitKey, seq: e.seq, effect, reason: `after "${EXPECTED_ORDER[furthest]}"` });
      } else if (missing !== undefined) {
        found.push({ visitKey, seq: e.seq, effect, reason: `before "${missing}"` });
      }
      seen.add(step);
      furthest = Math.max(furthest, step);
    }
  }
  return found;
}

function findOverlap(entries: readonly LogEntry[]): OverlappingRequests[] {
  const found: OverlappingRequests[] = [];
  for (const [visitKey, visitEntries] of byVisit(entries)) {
    for (let i = 0; i < visitEntries.length; i++) {
      for (let j = i + 1; j < visitEntries.length; j++) {
        const a = visitEntries[i];
        const b = visitEntries[j];
        if (!a || !b) continue; // indices are in range; this narrows for noUncheckedIndexedAccess
        if (a.receivedAt < b.respondedAt && b.receivedAt < a.respondedAt) found.push({ visitKey, seqs: [a.seq, b.seq] });
      }
    }
  }
  return found;
}

function byVisit(entries: readonly LogEntry[]): Map<string, LogEntry[]> {
  const visits = new Map<string, LogEntry[]>();
  for (const e of entries) {
    if (e.visitKey === null) continue;
    visits.set(e.visitKey, [...(visits.get(e.visitKey) ?? []), e]);
  }
  return visits;
}
