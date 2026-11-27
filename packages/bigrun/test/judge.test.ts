import type { LogEntry, MockReport } from '@integration-hub/mock-satusehat/client';
import type { BatchResult, CaseId, SendAnswer, VisitId } from '@integration-hub/simulator';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CaseView } from '../src/hub-cases.js';
import { judge, type JudgeInput } from '../src/judge.js';
import type { ManifestVisit } from '../src/manifest.js';
import { loadSettings } from '../src/settings.js';

const committed: unknown = JSON.parse(readFileSync(new URL('../../../bigrun.commitments.json', import.meta.url), 'utf8'));
// Two visits: the committed run with its counts set for them.
const { bigRun } = loadSettings(committed, [
  '--set', 'events.visits=2',
  '--set', 'events.uniqueEvents=8',
  '--set', 'events.duplicates=2',
  '--set', 'events.total=10',
  '--set', 'invariants.hubSide.completedCases=2',
  '--set', 'invariants.hubSide.completedSteps=8',
]);

const EVENTS = ['visit.started', 'prescription.written', 'drug.dispensed', 'visit.finished'] as const;
const STEPS = ['create_visit', 'submit_prescription', 'submit_dispense', 'update_visit'] as const;
const visits: ManifestVisit[] = ['V-A', 'V-B'].map((visitId) => ({
  visitId,
  scenario: 'as_prescribed',
  lookupMethod: 'nik',
  outOfOrder: false,
  patientIhsNumber: 'P1',
  prescribedKfaCode: '93000001',
  dispensedKfaCode: '93000001',
  expectedEffects: ['Encounter created', 'MedicationRequest created', 'MedicationDispense created', 'Encounter updated'],
}));

let key = 0;
function answer(visitId: string, eventType: (typeof EVENTS)[number], role: SendAnswer['role'], latencyMs: number): SendAnswer {
  return {
    visitId,
    eventType,
    idempotencyKey: `K-${visitId}-${eventType}`,
    role,
    timing: null,
    sentAfterMs: key++,
    latencyMs,
    status: 202,
    replayed: role === 'duplicate',
  } as SendAnswer; // branded ids built from plain test strings
}

/** 8 originals at 10..80ms and 2 duplicates at 90 and 100ms. */
const answers = (): SendAnswer[] => [
  ...visits.flatMap((v, i) => EVENTS.map((e, j) => answer(v.visitId, e, 'original', 10 * (i * 4 + j + 1)))),
  answer('V-A', 'visit.started', 'duplicate', 90),
  answer('V-B', 'visit.finished', 'duplicate', 100),
];

const batch = (overrides: Partial<BatchResult> = {}): BatchResult =>
  ({
    problems: [],
    cases: visits.map((v) => ({ visitId: v.visitId, caseId: `C-${v.visitId}`, status: 'completed', currentStep: null })),
    answers: answers(),
    ending: 'completed',
    startedAt: new Date('2026-11-27T01:00:00Z'),
    sendsEndedAfterMs: 2_000,
    endedAfterMs: 10_000,
    ...overrides,
  }) as BatchResult; // branded ids built from plain test strings

/** A completed case: accepted at :00, its last step completed `e2eSeconds` later; `attempts` per step. */
function completedCase(visitId: string, e2eSeconds: number, attempts: [number, number, number, number]): CaseView {
  const at = (s: number) => new Date(Date.parse('2026-11-27T01:00:00Z') + s * 1000).toISOString();
  return {
    // Branded ids built from plain test strings.
    caseId: `C-${visitId}` as CaseId,
    visitId: visitId as VisitId,
    status: 'completed',
    currentStep: null,
    waitingFor: null,
    deadLetterReason: null,
    events: EVENTS.map((type, i) => ({ type, receivedAt: at(i * 0.1) })),
    steps: STEPS.map((step, i) => ({
      step,
      state: 'completed',
      attempts: attempts[i] ?? 1,
      deadLetterReason: null,
      attemptLog: Array.from({ length: attempts[i] ?? 1 }, (_, n) => ({
        outcome: n === (attempts[i] ?? 1) - 1 ? 'completed' : 'failed',
        errorCode: null,
        startedAt: at(0),
        endedAt: at(i === 3 && n === (attempts[i] ?? 1) - 1 ? e2eSeconds : 0.5),
      })),
    })),
  };
}

let seq = 0;
function entry(method: string, path: string, resourceType: string | null, visitKey: string | null, effect: LogEntry['effect'], status: number | null, fault: string | null = null): LogEntry {
  return {
    seq: ++seq,
    receivedAt: new Date(Date.parse('2026-11-27T01:00:00Z') + seq).toISOString(),
    respondedAt: new Date(Date.parse('2026-11-27T01:00:00Z') + seq).toISOString(),
    method,
    path,
    resourceType,
    visitKey,
    businessIdentifier: null,
    request: { body: null },
    response: { status, body: null },
    fault,
    effect,
  };
}

/** Each visit's four effects in order, a faulted search and a faulted write before each, a token call and a KFA lookup. */
function mockLog(): LogEntry[] {
  return [
    entry('POST', '/oauth2/v1/accesstoken', null, null, 'none', 200),
    entry('GET', '/kfa-v2/products?code=1', 'KfaProduct', null, 'none', 200),
    ...visits.flatMap(({ visitId }) => [
      entry('GET', '/fhir-r4/v1/Encounter?identifier=x', 'Encounter', visitId, 'none', 503, 'reads:http_503'),
      entry('GET', '/fhir-r4/v1/Encounter?identifier=x', 'Encounter', visitId, 'none', 200),
      entry('POST', '/fhir-r4/v1/Encounter', 'Encounter', visitId, 'created', null, 'writes:timeout_after_apply:POST-Encounter'),
      entry('POST', '/fhir-r4/v1/MedicationRequest', 'MedicationRequest', visitId, 'created', 201),
      entry('POST', '/fhir-r4/v1/MedicationDispense', 'MedicationDispense', visitId, 'created', 201),
      entry('PUT', '/fhir-r4/v1/Encounter/1', 'Encounter', visitId, 'updated', 200),
    ]),
  ];
}

const emptyReport: MockReport = { faultSeed: 20261125, duplicates: [], outOfOrder: [], overlap: [] };

const input = (overrides: Partial<JudgeInput> = {}): JudgeInput => ({
  bigRun,
  visits,
  batch: batch(),
  cases: [completedCase('V-A', 4, [1, 2, 1, 1]), completedCase('V-B', 8, [3, 1, 1, 1])],
  mockLog: mockLog(),
  mockReport: emptyReport,
  ...overrides,
});

describe('judge', () => {
  it('passes when every invariant holds on both sides', () => {
    const judgement = judge(input());
    expect(judgement.verdict).toBe('PASS');
    expect(judgement.invariants.filter((check) => !check.pass)).toEqual([]);
    expect(judgement.invariants.map((check) => check.name)).toEqual([
      'every send answered as expected',
      'every simulator check held',
      'the batch drained',
      'steps claimable, in flight or in retry_wait',
      'completed cases',
      'waiting cases',
      'dead-lettered cases',
      'abandoned cases',
      'completed steps',
      'visits with their four effects in order at the mock',
      'mock report: duplicate submissions',
      'mock report: out-of-order effects',
      'mock report: overlapping requests',
    ]);
    expect(judgement.unfinishedCases).toEqual([]);
  });

  it('fails on any failed simulator check, such as a concurrent pair answered fresh twice or a replay with another body', () => {
    const problem = 'V-A visit.started: a concurrent pair was answered 202 and 202, not one 202 and its replay';
    const judgement = judge(input({ batch: batch({ problems: [problem] }) }));
    expect(judgement.verdict).toBe('FAIL');
    expect(judgement.invariants.filter((check) => !check.pass).map((check) => [check.name, check.expected, check.actual])).toEqual([
      ['every simulator check held', 0, 1],
    ]);
  });

  it('fails the drain while a step of the run is still claimable, in flight or in retry_wait', () => {
    const open = completedCase('V-B', 8, [1, 1, 1, 1]);
    open.steps = open.steps.map((step) => (step.step === 'update_visit' ? { ...step, state: 'retry_wait' } : step));
    const judgement = judge(input({ cases: [completedCase('V-A', 4, [1, 1, 1, 1]), open] }));
    expect(judgement.invariants.find((check) => check.name === 'steps claimable, in flight or in retry_wait')).toMatchObject({ expected: 0, actual: 1, pass: false });
  });

  it('fails when a visit is missing an effect at the mock, or the mock reports a duplicate', () => {
    const log = mockLog().filter((e) => !(e.visitKey === 'V-B' && e.effect === 'updated'));
    const duplicate = { resourceType: 'Encounter', effect: 'created' as const, businessIdentifier: 'x|V-A', visitKey: 'V-A', seqs: [5, 9] };
    const judgement = judge(input({ mockLog: log, mockReport: { ...emptyReport, duplicates: [duplicate] } }));
    expect(judgement.verdict).toBe('FAIL');
    const failed = judgement.invariants.filter((check) => !check.pass);
    expect(failed.map((check) => [check.name, check.expected, check.actual])).toEqual([
      ['visits with their four effects in order at the mock', 2, 1],
      ['mock report: duplicate submissions', 0, 1],
    ]);
    expect(judgement.mockSideMismatches).toEqual([
      { visitId: 'V-B', effects: ['Encounter created', 'MedicationRequest created', 'MedicationDispense created'] },
    ]);
  });

  it('fails on an unexpected answer, and lists every case that did not complete', () => {
    const wrong = answers().map((a, i) => (i === 9 ? { ...a, replayed: false } : a));
    const stuck: CaseView = {
      ...completedCase('V-B', 8, [1, 1, 15, 0]),
      status: 'dead_lettered',
      currentStep: 'submit_dispense',
      deadLetterReason: 'RETRIES_EXHAUSTED',
    };
    stuck.steps = stuck.steps.map((step) =>
      step.step === 'submit_dispense'
        ? { ...step, state: 'dead_lettered', deadLetterReason: 'RETRIES_EXHAUSTED' }
        : step.step === 'update_visit'
          ? { ...step, state: 'awaiting_event', attempts: 0, attemptLog: [] }
          : step,
    );
    const judgement = judge(input({ batch: batch({ answers: wrong, ending: 'settled' }), cases: [completedCase('V-A', 4, [1, 1, 1, 1]), stuck] }));
    expect(judgement.verdict).toBe('FAIL');
    expect(judgement.invariants.filter((check) => !check.pass).map((check) => [check.name, check.expected, check.actual])).toEqual([
      ['every send answered as expected', 10, 9],
      ['the batch drained', 'completed', 'settled'],
      ['completed cases', 2, 1],
      ['dead-lettered cases', 0, 1],
      ['completed steps', 8, 6],
    ]);
    expect(judgement.unfinishedCases).toEqual([
      { visitId: 'V-B', caseId: 'C-V-B', status: 'dead_lettered', currentStep: 'submit_dispense', waitingFor: null, deadLetterReason: 'RETRIES_EXHAUSTED', attempts: 15 },
    ]);
  });

  it('measures ingest latency, end-to-end time per case and attempts per step', () => {
    const { measurements } = judge(input());
    // Ten answers at 10..100ms, nearest rank.
    expect(measurements.ingestLatencyMs).toEqual({ count: 10, p50: 50, p95: 100, p99: 100, max: 100 });
    expect(measurements.endToEndSeconds).toEqual({ count: 2, p50: 4, p95: 8, p99: 8, max: 8 });
    expect(measurements.attemptsPerStep.create_visit).toEqual({ max: 3, p99: 3, mean: 2, histogram: { 1: 1, 3: 1 } });
    expect(measurements.attemptsPerStep.submit_prescription).toEqual({ max: 2, p99: 2, mean: 1.5, histogram: { 1: 1, 2: 1 } });
    expect(measurements.throughput).toEqual({ acceptedEventsPerSecond: 5, completedStepsPerSecond: 0.8 });
  });

  it('counts late duplicates out of the accepted rate, as they go after the sending window', () => {
    const late = { ...answer('V-A', 'drug.dispensed', 'duplicate', 10), timing: 'late' as const, sentAfterMs: 5_000 };
    const { measurements } = judge(input({ batch: batch({ answers: [...answers(), late] }) }));
    expect(measurements.throughput.acceptedEventsPerSecond).toBe(5);
    expect(measurements.durationsSeconds).toEqual({ send: 2, drain: 8, total: 10 });
  });

  it('measures the realized fault rate per group and upstream calls by status class, from the mock log', () => {
    const { measurements } = judge(input());
    expect(measurements.faults.reads).toEqual({ calls: 5, faulted: 2, rate: 0.4, byKind: { http_503: 2 } });
    expect(measurements.faults.writes).toEqual({ calls: 8, faulted: 2, rate: 0.25, byKind: { timeout_after_apply: 2 } });
    expect(measurements.platformApiCalls).toEqual({
      token: { '2xx': 1 },
      kfa: { '2xx': 1 },
      fhir: { '2xx': 8, '5xx': 2, cut: 2 },
    });
  });
});
