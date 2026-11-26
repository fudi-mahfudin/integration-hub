// The report's out-of-order and overlap rules can't yet be provoked through
// HTTP: they need MedicationRequest create (#29) and latency faults (#33).
// Until then they are table-tested here, as a pure function of log entries.
import { describe, expect, it } from 'vitest';
import { computeReport } from '../src/report.js';
import type { Effect, LogEntry } from '../src/submission-log.js';

let seq = 0;
function entry(resourceType: string, effect: Effect, opts: { visitKey?: string; id?: string; at?: [number, number] } = {}): LogEntry {
  seq += 1;
  const [received, responded] = opts.at ?? [seq * 10, seq * 10 + 5];
  return {
    seq,
    receivedAt: new Date(Date.UTC(2026, 2, 2, 1, 0, 0, received)).toISOString(),
    respondedAt: new Date(Date.UTC(2026, 2, 2, 1, 0, 0, responded)).toISOString(),
    method: 'POST',
    path: `/fhir-r4/v1/${resourceType}`,
    resourceType,
    visitKey: opts.visitKey ?? 'V-1',
    businessIdentifier: opts.id ?? `${resourceType}|V-1`,
    request: { body: {} },
    response: { status: 201, body: {} },
    fault: null,
    effect,
  };
}

describe('report', () => {
  it('is empty for one visit whose four effects land once and in order', () => {
    const report = computeReport(
      [
        entry('Encounter', 'created'),
        entry('MedicationRequest', 'created'),
        entry('MedicationDispense', 'created'),
        entry('Encounter', 'updated'),
      ],
      null,
    );
    expect(report).toEqual({ faultSeed: null, duplicates: [], outOfOrder: [], overlap: [] });
  });

  it('echoes the fault seed', () => {
    expect(computeReport([], 42).faultSeed).toBe(42);
  });

  it('flags a second create for the same business identifier, not a rejected one', () => {
    const first = entry('Encounter', 'created');
    const rejected = entry('Encounter', 'none');
    const second = entry('Encounter', 'created');
    expect(computeReport([first, rejected, second], null).duplicates).toEqual([
      { resourceType: 'Encounter', effect: 'created', businessIdentifier: 'Encounter|V-1', visitKey: 'V-1', seqs: [first.seq, second.seq] },
    ]);
  });

  it('does not flag creates of different business identifiers', () => {
    const report = computeReport([entry('Encounter', 'created', { id: 'a' }), entry('Encounter', 'created', { id: 'b' })], null);
    expect(report.duplicates).toEqual([]);
  });

  it('flags an effect whose predecessor has not landed', () => {
    const request = entry('MedicationRequest', 'created');
    expect(computeReport([request], null).outOfOrder).toEqual([
      { visitKey: 'V-1', seq: request.seq, effect: 'MedicationRequest created', reason: 'before "Encounter created"' },
    ]);
  });

  it('flags an effect that lands after a later step', () => {
    const encounter = entry('Encounter', 'created');
    const request = entry('MedicationRequest', 'created');
    const dispense = entry('MedicationDispense', 'created');
    const late = entry('MedicationRequest', 'created', { id: 'MR-2' });
    expect(computeReport([encounter, request, dispense, late], null).outOfOrder).toEqual([
      { visitKey: 'V-1', seq: late.seq, effect: 'MedicationRequest created', reason: 'after "MedicationDispense created"' },
    ]);
  });

  it('judges order per visit', () => {
    const report = computeReport(
      [entry('Encounter', 'created', { visitKey: 'A' }), entry('Encounter', 'created', { visitKey: 'B', id: 'B' }), entry('MedicationRequest', 'created', { visitKey: 'A' })],
      null,
    );
    expect(report.outOfOrder).toEqual([]);
  });

  it('flags two requests for one visit that were in flight together, searches included', () => {
    const a = entry('Encounter', 'none', { at: [0, 100] });
    const b = entry('Encounter', 'created', { at: [50, 150] });
    expect(computeReport([a, b], null).overlap).toEqual([{ visitKey: 'V-1', seqs: [a.seq, b.seq] }]);
  });

  it('does not flag back-to-back requests or requests for different visits', () => {
    const report = computeReport(
      [
        entry('Encounter', 'none', { at: [0, 100] }),
        entry('Encounter', 'created', { at: [100, 200] }),
        entry('Encounter', 'none', { visitKey: 'V-2', at: [150, 250] }),
      ],
      null,
    );
    expect(report.overlap).toEqual([]);
  });
});
