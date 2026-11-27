// The verdict of a big run: every committed invariant checked from the hub's
// side and the mock's, against the manifest, and the measurements the report
// shows beside it (information only, never a pass criterion).
import type { LogEntry, MockReport } from '@integration-hub/mock-satusehat/client';
import type { BatchResult } from '@integration-hub/simulator';
import { faultOfRule, WRITES, type FaultGroup } from './fault-rules.js';
import type { CaseView } from './hub-cases.js';
import type { ManifestVisit } from './manifest.js';
import type { BigRunCommitments } from './settings.js';

/** What a run is judged on. */
export interface JudgeInput {
  bigRun: BigRunCommitments;
  /** The manifest's visits. */
  visits: readonly ManifestVisit[];
  /** What the simulator saw. */
  batch: BatchResult;
  /** Every case the run opened, read through the case API after waiting ended. */
  cases: readonly CaseView[];
  /** The mock's whole submission log. */
  mockLog: readonly LogEntry[];
  mockReport: MockReport;
}

/** One invariant: what it must be, what it was. */
export interface InvariantCheck {
  name: string;
  expected: number | string;
  actual: number | string;
  pass: boolean;
}

/** A case of the run that did not complete: waiting, active, dead-lettered, abandoned, or never opened. */
export interface UnfinishedCase {
  visitId: string;
  caseId: string | null;
  status: string;
  currentStep: string | null;
  waitingFor: string | null;
  deadLetterReason: string | null;
  /** Attempts at its current step. */
  attempts: number;
}

/** p50, p95, p99 and max of a sample (nearest rank), and its size. */
export interface Percentiles {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/** How many attempts each step took, over the run's cases. */
export interface AttemptStats {
  max: number;
  p99: number;
  mean: number;
  /** How many cases took each number of attempts. */
  histogram: Record<number, number>;
}

/** The share of a fault group's calls the mock faulted. */
export interface RealizedFaults {
  calls: number;
  faulted: number;
  rate: number;
  byKind: Record<string, number>;
}

/** Which platform API a call went to, by its path at the mock. */
export type PlatformApi = 'token' | 'fhir' | 'kfa';
/** An answer's HTTP status class, or `cut` for a connection dropped without one. */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'cut';

/** The measurements from the simulator, the case API and the mock log. */
export interface Measurements {
  throughput: { acceptedEventsPerSecond: number; completedStepsPerSecond: number };
  /** Client-side, request to whole answer, over every send. */
  ingestLatencyMs: Percentiles;
  /** First event accepted to last step completed, per completed case. */
  endToEndSeconds: Percentiles;
  attemptsPerStep: Record<string, AttemptStats>;
  faults: Record<FaultGroup, RealizedFaults>;
  platformApiCalls: Partial<Record<PlatformApi, Partial<Record<StatusClass, number>>>>;
  /** Sending, then waiting after the last send, and both. */
  durationsSeconds: { send: number; drain: number; total: number };
}

/** The verdict, the checks behind it, and the measurements. */
export interface Judgement {
  verdict: 'PASS' | 'FAIL';
  invariants: InvariantCheck[];
  unfinishedCases: UnfinishedCase[];
  /** Manifest visits whose effects at the mock were not the four in order, with what they were. */
  mockSideMismatches: { visitId: string; effects: string[] }[];
  measurements: Measurements;
}

/** FHIR resources the hub writes; a POST or PUT of one is a write. */
const WRITTEN_TYPES = new Set<string>(WRITES.map((w) => w.resourceType));
/** Step states in which a worker has the step, or may claim it. */
const OPEN_STATES = new Set(['ready', 'in_flight', 'retry_wait']);

/**
 * Judges a run. PASS only if every committed invariant holds: every answer
 * as expected, the batch drained, the hub-side case and step counts, each
 * manifest visit's four effects in order in the mock log, and empty
 * duplicate, out-of-order and overlap sections in the mock report.
 */
export function judge(input: JudgeInput): Judgement {
  const { bigRun, visits, batch, cases, mockLog, mockReport } = input;
  const hubSide = bigRun.invariants.hubSide;
  const casesOf = (status: string) => cases.filter((c) => c.status === status).length;
  const completedSteps = cases.reduce((n, c) => n + c.steps.filter((s) => s.state === 'completed').length, 0);

  const openSteps = cases.reduce((n, c) => n + c.steps.filter((s) => OPEN_STATES.has(s.state)).length, 0);
  const answeredAsExpected = batch.answers.filter((a) => a.status === 202 && a.replayed === (a.role === 'duplicate')).length;
  const mockSideMismatches = visits.flatMap((visit) => {
    const effects = mockLog
      .filter((e) => e.visitKey === visit.visitId && (e.effect === 'created' || e.effect === 'updated'))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => `${e.resourceType} ${e.effect}`);
    const inOrder = effects.length === visit.expectedEffects.length && effects.every((effect, i) => effect === visit.expectedEffects[i]);
    return inOrder ? [] : [{ visitId: visit.visitId, effects }];
  });

  const check = (name: string, expected: number | string, actual: number | string): InvariantCheck => ({ name, expected, actual, pass: expected === actual });
  const invariants = [
    {
      ...check('every send answered as expected', bigRun.events.total, answeredAsExpected),
      pass: answeredAsExpected === bigRun.events.total && batch.answers.length === bigRun.events.total,
    },
    // The simulator's own checks: a concurrent pair answered one fresh and one replay, a replay with the original's body, every send answered.
    check('every simulator check held', 0, batch.problems.length),
    check('the batch drained', 'completed', batch.ending),
    check('steps claimable, in flight or in retry_wait', 0, openSteps),
    check('completed cases', hubSide.completedCases, casesOf('completed')),
    check('waiting cases', hubSide.waitingCases, casesOf('waiting')),
    check('dead-lettered cases', hubSide.deadLetteredCases, casesOf('dead_lettered')),
    check('abandoned cases', hubSide.abandonedCases, casesOf('abandoned')),
    check('completed steps', hubSide.completedSteps, completedSteps),
    check('visits with their four effects in order at the mock', visits.length, visits.length - mockSideMismatches.length),
    check('mock report: duplicate submissions', 0, mockReport.duplicates.length),
    check('mock report: out-of-order effects', 0, mockReport.outOfOrder.length),
    check('mock report: overlapping requests', 0, mockReport.overlap.length),
  ];

  const byVisit = new Map<string, CaseView>(cases.map((c) => [c.visitId, c]));
  const unfinishedCases: UnfinishedCase[] = visits.flatMap(({ visitId }) => {
    const view = byVisit.get(visitId);
    if (view?.status === 'completed') return [];
    const current = view?.steps.find((s) => s.step === view.currentStep);
    return [
      {
        visitId,
        caseId: view?.caseId ?? null,
        status: view?.status ?? 'no case',
        currentStep: view?.currentStep ?? null,
        waitingFor: view?.waitingFor ?? null,
        deadLetterReason: view?.deadLetterReason ?? null,
        attempts: current?.attempts ?? 0,
      },
    ];
  });

  return {
    verdict: invariants.every((c) => c.pass) ? 'PASS' : 'FAIL',
    invariants,
    unfinishedCases,
    mockSideMismatches,
    measurements: measure(batch, cases, mockLog, completedSteps),
  };
}

function measure(batch: BatchResult, cases: readonly CaseView[], mockLog: readonly LogEntry[], completedSteps: number): Measurements {
  const seconds = (ms: number) => ms / 1000;
  // Late duplicates go after the sending window, once their cases completed, so they don't count towards its rate.
  const accepted = batch.answers.filter((a) => a.status === 202 && !(a.role === 'duplicate' && a.timing === 'late')).length;

  const endToEnd = cases.flatMap((c) => {
    if (c.status !== 'completed') return [];
    const first = Math.min(...c.events.map((e) => Date.parse(e.receivedAt)));
    const ends = c.steps.flatMap((s) => s.attemptLog.filter((a) => a.outcome === 'completed' && a.endedAt !== null).map((a) => Date.parse(a.endedAt ?? '')));
    return ends.length > 0 && Number.isFinite(first) ? [seconds(Math.max(...ends) - first)] : [];
  });

  const attemptsPerStep: Record<string, AttemptStats> = {};
  const stepNames = [...new Set(cases.flatMap((c) => c.steps.map((s) => s.step)))];
  for (const step of stepNames) {
    const attempts = cases.flatMap((c) => c.steps.filter((s) => s.step === step && s.attempts > 0).map((s) => s.attempts));
    if (attempts.length === 0) continue;
    const histogram: Record<number, number> = {};
    for (const n of attempts) histogram[n] = (histogram[n] ?? 0) + 1;
    attemptsPerStep[step] = {
      max: Math.max(...attempts),
      p99: percentile(attempts, 0.99) ?? 0,
      mean: attempts.reduce((a, b) => a + b, 0) / attempts.length,
      histogram,
    };
  }

  const faults: Record<FaultGroup, RealizedFaults> = { reads: emptyFaults(), writes: emptyFaults() };
  const platformApiCalls: Measurements['platformApiCalls'] = {};
  for (const e of mockLog) {
    const group = groupOf(e);
    if (group !== null) {
      const tally = faults[group];
      tally.calls++;
      const kind = e.fault === null ? null : (faultOfRule(e.fault)?.kind ?? e.fault);
      if (kind !== null) {
        tally.faulted++;
        tally.byKind[kind] = (tally.byKind[kind] ?? 0) + 1;
      }
    }
    const api = platformApiOf(e.path);
    if (api !== null) {
      const statusClass = statusClassOf(e.response.status);
      const classes = (platformApiCalls[api] ??= {});
      classes[statusClass] = (classes[statusClass] ?? 0) + 1;
    }
  }
  for (const tally of Object.values(faults)) tally.rate = tally.calls === 0 ? 0 : tally.faulted / tally.calls;

  return {
    throughput: {
      acceptedEventsPerSecond: batch.sendsEndedAfterMs > 0 ? accepted / seconds(batch.sendsEndedAfterMs) : 0,
      completedStepsPerSecond: batch.endedAfterMs > 0 ? completedSteps / seconds(batch.endedAfterMs) : 0,
    },
    ingestLatencyMs: percentiles(batch.answers.filter((a) => a.status !== null).map((a) => a.latencyMs)),
    endToEndSeconds: percentiles(endToEnd),
    attemptsPerStep,
    faults,
    platformApiCalls,
    durationsSeconds: {
      send: seconds(batch.sendsEndedAfterMs),
      drain: seconds(batch.endedAfterMs - batch.sendsEndedAfterMs),
      total: seconds(batch.endedAfterMs),
    },
  };
}

const emptyFaults = (): RealizedFaults => ({ calls: 0, faulted: 0, rate: 0, byKind: {} });

/** The fault group a logged call belongs to: every GET is a read, a POST or PUT of a written FHIR resource a write; the token endpoint neither. */
function groupOf(e: LogEntry): FaultGroup | null {
  if (e.method === 'GET') return 'reads';
  if ((e.method === 'POST' || e.method === 'PUT') && e.resourceType !== null && WRITTEN_TYPES.has(e.resourceType)) return 'writes';
  return null;
}

function statusClassOf(status: number | null): StatusClass {
  if (status === null) return 'cut';
  if (status < 300) return '2xx';
  if (status < 400) return '3xx';
  if (status < 500) return '4xx';
  return '5xx';
}

function platformApiOf(path: string): PlatformApi | null {
  if (path.startsWith('/oauth2/')) return 'token';
  if (path.startsWith('/fhir-r4/')) return 'fhir';
  if (path.startsWith('/kfa-v2/')) return 'kfa';
  return null;
}

/** The nearest-rank percentile `p` (0-1) of a sample, or null for an empty one. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function percentiles(values: readonly number[]): Percentiles {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? null : Math.max(...values),
  };
}
