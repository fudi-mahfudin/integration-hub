import { describe, expect, it } from 'vitest';
import { reportFromLog, type LogEntry } from '../src/index.js';
import { validEncounter } from './support/encounters.js';
import { useMock } from './support/platform.js';

describe('GET /__mock/report', () => {
  const ctx = useMock();

  it('is empty for one create per visit and echoes the (unset) fault seed', async () => {
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-R1'));
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-R2'));
    expect(await ctx.client.report()).toEqual({
      faultSeed: null,
      duplicateSubmissions: [],
      outOfOrderEffects: [],
      overlappingInFlight: [],
    });
  });

  it('flags a second created Encounter for the same business identifier', async () => {
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-DUP'));
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-OTHER'));
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-DUP'));
    const creates = await ctx.client.log({ visitKey: 'VISIT-DUP' });

    const report = await ctx.client.report();
    expect(report.duplicateSubmissions).toEqual([
      {
        resourceType: 'Encounter',
        key: 'http://sys-ids.kemkes.go.id/encounter/99000001|VISIT-DUP',
        effect: 'created',
        seqs: creates.map((e) => e.seq),
      },
    ]);
  });

  it('does not count rejected creates', async () => {
    await ctx.platform.fhir('POST', '/Encounter', validEncounter('VISIT-REJ'));
    const bad = validEncounter('VISIT-REJ');
    bad.period.start = '2026-01-01T00:00:00Z';
    await ctx.platform.fhir('POST', '/Encounter', bad);
    expect((await ctx.client.report()).duplicateSubmissions).toEqual([]);
  });

  it('finds no overlap between sequential requests for one visit', async () => {
    for (let i = 0; i < 5; i++) await ctx.platform.fhir('POST', '/Encounter', validEncounter("VISIT-SEQ"));
    expect((await ctx.client.report()).overlappingInFlight).toEqual([]);
  });
});

// The same computation over a log artifact (e.g. a big run's log.ndjson).
describe('reportFromLog', () => {
  let seq = 0;
  const entry = (p: Partial<LogEntry> & { receivedAt: string; respondedAt: string }): LogEntry => ({
    seq: ++seq,
    kind: 'platform',
    method: 'POST',
    path: '/fhir-r4/v1/x',
    resourceType: null,
    visitKey: null,
    businessIdentifier: null,
    request: { query: {}, body: null },
    response: { status: 201, body: null },
    fault: null,
    effect: 'none',
    ...p,
  });
  const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const effect = (visitKey: string, resourceType: string, eff: 'created' | 'updated', at: number, id = `${resourceType}-${visitKey}`) =>
    entry({ visitKey, resourceType, effect: eff, businessIdentifier: id, receivedAt: t(at), respondedAt: t(at) });

  it('accepts the expected order Encounter created, MR created, MD created, Encounter updated', () => {
    const log = [
      effect('V1', 'Encounter', 'created', 1),
      effect('V1', 'MedicationRequest', 'created', 2),
      effect('V1', 'MedicationDispense', 'created', 3),
      effect('V1', 'Encounter', 'updated', 4),
    ];
    expect(reportFromLog(log, 7).outOfOrderEffects).toEqual([]);
    expect(reportFromLog(log, 7).faultSeed).toBe(7);
  });

  it('flags an effect that lands after a later-stage effect of the same visit', () => {
    const enc = effect('V2', 'Encounter', 'created', 1);
    const md = effect('V2', 'MedicationDispense', 'created', 2);
    const mr = effect('V2', 'MedicationRequest', 'created', 3);
    const otherVisit = effect('V3', 'Encounter', 'created', 4);
    const report = reportFromLog([enc, md, mr, otherVisit], null);
    expect(report.outOfOrderEffects).toEqual([
      { visitKey: 'V2', seq: mr.seq, effect: 'MedicationRequest created', after: { seq: md.seq, effect: 'MedicationDispense created' } },
    ]);
  });

  it('flags a second applied update-visit per visit as a duplicate submission', () => {
    const a = effect('V4', 'Encounter', 'updated', 1, 'Encounter-id-1');
    const b = effect('V4', 'Encounter', 'updated', 2, 'Encounter-id-1');
    expect(reportFromLog([a, b], null).duplicateSubmissions).toEqual([
      { resourceType: 'Encounter', key: 'V4', effect: 'updated', seqs: [a.seq, b.seq] },
    ]);
  });

  it('flags overlapping in-flight requests for the same visit only', () => {
    const a = entry({ visitKey: 'V5', receivedAt: t(1), respondedAt: t(5) });
    const b = entry({ visitKey: 'V5', receivedAt: t(3), respondedAt: t(4) });
    const otherVisit = entry({ visitKey: 'V6', receivedAt: t(2), respondedAt: t(6) });
    const touching = entry({ visitKey: 'V5', receivedAt: t(5), respondedAt: t(7) });
    const noVisit = entry({ visitKey: null, receivedAt: t(1), respondedAt: t(9) });
    expect(reportFromLog([a, b, otherVisit, touching, noVisit], null).overlappingInFlight).toEqual([
      { visitKey: 'V5', seqs: [a.seq, b.seq] },
    ]);
  });

  it('ignores admin entries', () => {
    const log = [
      entry({ kind: 'admin', visitKey: 'V7', receivedAt: t(1), respondedAt: t(5) }),
      entry({ visitKey: 'V7', receivedAt: t(2), respondedAt: t(3) }),
    ];
    expect(reportFromLog(log, null).overlappingInFlight).toEqual([]);
  });
});
