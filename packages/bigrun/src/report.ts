// A run's report: `report.json` holds everything, `report.md` is its reading copy.
import type { BatchEnding } from '@integration-hub/simulator';
import type { Judgement } from './judge.js';
import type { PrometheusMeasurements } from './prometheus.js';
import { REPO, type IndexedRun } from './publish.js';
import type { ReconciliationOutcome } from './reconciliation.js';
import type { Override, RunKind } from './settings.js';
import type { Environment } from './system.js';

/** What fixes the commitments a run was judged by: the tree it ran from and the commitments file as read. */
export interface Provenance {
  gitSha: string;
  /** `git status --porcelain` lines at the start; always empty for an official run. */
  uncommitted: string[];
  commitmentsSha256: string;
  /** The last commit that changed the commitments file, or null if it never was committed. */
  commitmentsCommit: { sha: string; date: string } | null;
}

/** A report's `## Provenance` section, as Markdown lines. */
export function provenanceLines(provenance: Provenance): string[] {
  return [
    '## Provenance',
    '',
    `- Git SHA: [\`${provenance.gitSha}\`](${REPO}/commit/${provenance.gitSha})${provenance.uncommitted.length > 0 ? ` with ${provenance.uncommitted.length} uncommitted changes` : ''}`,
    `- \`bigrun.commitments.json\` SHA-256: \`${provenance.commitmentsSha256}\``,
    provenance.commitmentsCommit === null
      ? '- The commitments file was never committed.'
      : `- Its last commit: [\`${provenance.commitmentsCommit.sha.slice(0, 7)}\`](${REPO}/commit/${provenance.commitmentsCommit.sha}), ${provenance.commitmentsCommit.date}`,
    '',
  ];
}

/** Everything a run found: `report.json`. */
export interface Report {
  dir: string;
  kind: RunKind;
  verdict: Judgement['verdict'];
  runId: string;
  startedAt: string;
  endedAt: string;
  ending: BatchEnding;
  provenance: Provenance;
  /** Committed values this run replaced (`--set`); a run with any is not official. */
  overrides: Override[];
  faultSeed: number;
  events: { visits: number; total: number };
  invariants: Judgement['invariants'];
  unfinishedCases: Judgement['unfinishedCases'];
  /** Cases the case API could not show after waiting ended, with why; each counts as not completed. */
  unreadableCases: { caseId: string; error: string }[];
  /** Why the mock's log or report could not be read, or null; without them every mock-side check fails. */
  mockReadError: string | null;
  mockSideMismatches: Judgement['mockSideMismatches'];
  /** The simulator's failed checks (first 100), each naming its visit. */
  simulatorProblems: string[];
  measurements: Judgement['measurements'];
  prometheus: PrometheusMeasurements;
  reconciliation: ReconciliationOutcome;
  environment: Environment;
  /** Where the gzipped mock log goes: a GitHub Release asset for an official run. */
  mockLog: { file: string; releaseTag: string | null };
}

const fixed = (value: number | null, digits: number) => (value === null ? 'n/a' : value.toFixed(digits));

/** The report as Markdown, for `report.md`. */
export function renderReport(report: Report): string {
  const m = report.measurements;
  const p = report.prometheus;
  const lines: string[] = [
    `# Big run ${report.dir}: ${report.verdict}`,
    '',
    report.kind === 'official'
      ? 'An **official** run: the committed big run, unchanged, from a clean tree.'
      : `**Not an official run** (${report.kind}). It is never published as the big run.`,
    '',
  ];
  if (report.overrides.length > 0) {
    lines.push('> [!WARNING]', '> **Overrides.** This run replaced committed values, so it is not official:', '>');
    for (const o of report.overrides) lines.push(`> - \`${o.path}\` = \`${JSON.stringify(o.value)}\``);
    lines.push('');
  }
  lines.push(
    `Run \`${report.runId}\`, ${report.events.visits.toLocaleString('en-US')} visits and ${report.events.total.toLocaleString('en-US')} events, fault seed ${report.faultSeed}. Started ${report.startedAt}, ended ${report.endedAt}: ${report.ending}.`,
    '',
    ...provenanceLines(report.provenance),
    '## Invariants',
    '',
    '| Check | Expected | Actual | |',
    '|---|---|---|---|',
    ...report.invariants.map((c) => `| ${c.name} | ${c.expected} | ${c.actual} | ${c.pass ? 'PASS' : '**FAIL**'} |`),
    '',
  );
  if (report.mockReadError !== null) lines.push(`**The mock could not be read:** ${report.mockReadError}. Every mock-side check fails.`, '');
  if (report.unreadableCases.length > 0) {
    lines.push(`## Cases the case API could not show (${report.unreadableCases.length})`, '', ...report.unreadableCases.slice(0, 50).map((c) => `- ${c.caseId}: ${c.error}`), '');
  }
  if (report.unfinishedCases.length > 0) {
    lines.push(`## Unfinished cases (${report.unfinishedCases.length})`, '', '| Visit | Case | Status | Step | Waiting for | Dead-letter reason | Attempts |', '|---|---|---|---|---|---|---|');
    for (const s of report.unfinishedCases.slice(0, 200)) {
      lines.push(`| ${s.visitId} | ${s.caseId ?? '-'} | ${s.status} | ${s.currentStep ?? '-'} | ${s.waitingFor ?? '-'} | ${s.deadLetterReason ?? '-'} | ${s.attempts} |`);
    }
    if (report.unfinishedCases.length > 200) lines.push('', `…and ${report.unfinishedCases.length - 200} more in report.json.`);
    lines.push('');
  }
  if (report.mockSideMismatches.length > 0) {
    lines.push(`## Visits whose effects at the mock were wrong (${report.mockSideMismatches.length})`, '');
    for (const v of report.mockSideMismatches.slice(0, 50)) lines.push(`- ${v.visitId}: ${v.effects.join(' → ') || 'none'}`);
    lines.push('');
  }
  if (report.simulatorProblems.length > 0) {
    lines.push('## Simulator checks that failed', '', ...report.simulatorProblems.slice(0, 50).map((problem) => `- ${problem}`), '');
  }
  lines.push(
    '## Measurements',
    '',
    'Information only: none of these is a pass criterion.',
    '',
    '| Measurement | Value |',
    '|---|---|',
    `| Accepted events/s (simulator) | ${m.throughput.acceptedEventsPerSecond.toFixed(1)} |`,
    `| Completed steps/s (case API; Prometheus) | ${m.throughput.completedStepsPerSecond.toFixed(2)}; ${fixed(p.completedStepsPerSecond, 2)} |`,
    `| Ingest latency p50 / p95 / p99, client (${m.ingestLatencyMs.count} requests) | ${fixed(m.ingestLatencyMs.p50, 0)} / ${fixed(m.ingestLatencyMs.p95, 0)} / ${fixed(m.ingestLatencyMs.p99, 0)} ms |`,
    `| Ingest latency p50 / p95 / p99, server (Prometheus, bucketed) | ${fixed(p.ingestServerMs.p50, 0)} / ${fixed(p.ingestServerMs.p95, 0)} / ${fixed(p.ingestServerMs.p99, 0)} ms |`,
    `| End-to-end per case p50 / p95 / p99 / max | ${fixed(m.endToEndSeconds.p50, 1)} / ${fixed(m.endToEndSeconds.p95, 1)} / ${fixed(m.endToEndSeconds.p99, 1)} / ${fixed(m.endToEndSeconds.max, 1)} s |`,
    `| Outbox lag max / p95 | ${fixed(p.outboxLagSeconds.max, 1)} / ${fixed(p.outboxLagSeconds.p95, 1)} s |`,
    `| Rate limiter wait p95 | ${fixed(p.limiterWaitP95Seconds === null ? null : p.limiterWaitP95Seconds * 1000, 0)} ms |`,
    `| Circuit breaker opens | ${Object.entries(p.breakerOpens).map(([upstream, n]) => `${upstream} ${n}`).join(', ') || 'none'} |`,
    `| Durations: send / drain / total | ${m.durationsSeconds.send.toFixed(0)} / ${m.durationsSeconds.drain.toFixed(0)} / ${m.durationsSeconds.total.toFixed(0)} s |`,
    '',
    '### Realized faults (mock log)',
    '',
    '| Group | Calls | Faulted | Rate | By kind |',
    '|---|---|---|---|---|',
    ...(['reads', 'writes'] as const).map((group) => {
      const f = m.faults[group];
      const kinds = Object.entries(f.byKind).map(([kind, n]) => `${kind} ${n}`).join(', ');
      return `| ${group} | ${f.calls} | ${f.faulted} | ${(f.rate * 100).toFixed(1)}% | ${kinds} |`;
    }),
    '',
    '### Attempts per step (case API)',
    '',
    '| Step | Mean | p99 | Max | Histogram (attempts: cases) |',
    '|---|---|---|---|---|',
    ...Object.entries(m.attemptsPerStep).map(
      ([step, a]) => `| ${step} | ${a.mean.toFixed(2)} | ${a.p99} | ${a.max} | ${Object.entries(a.histogram).map(([n, count]) => `${n}: ${count}`).join(', ')} |`,
    ),
    '',
    '### Platform API calls by status class (mock log)',
    '',
    '| Platform API | 2xx | 4xx | 5xx | Cut |',
    '|---|---|---|---|---|',
    ...Object.entries(m.platformApiCalls).map(([api, c]) => `| ${api} | ${c['2xx'] ?? 0} | ${c['4xx'] ?? 0} | ${c['5xx'] ?? 0} | ${c.cut ?? 0} |`),
    '',
    '### Reconciliation after the drain',
    '',
    'error' in report.reconciliation
      ? `No counts: ${report.reconciliation.error}.`
      : `Run \`${report.reconciliation.runId}\` ${report.reconciliation.status}: ${Object.entries(report.reconciliation.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
    '',
  );
  if (p.errors.length > 0) lines.push('Prometheus queries that failed:', '', ...p.errors.map((e) => `- \`${e}\``), '');
  const env = report.environment;
  lines.push(
    '## Environment',
    '',
    `- ${environmentLine(env)}`,
    `- Docker has ${env.dockerCpus} CPUs and ${env.dockerRamGiB} GiB; compose ${env.compose}; ${env.workerProcesses} worker processes`,
    `- Container limits: ${env.containerLimits.map((c) => `${c.service} ${c.cpus ?? '∞'} CPU / ${c.memoryBytes === null ? '∞' : `${Math.round(c.memoryBytes / 1024 / 1024)} MiB`}`).join(', ')}`,
    '',
    '## Files',
    '',
    '- `manifest.json`: every planned visit and send, written before the first send',
    '- `mock-report.json`: `GET /__mock/report` after the drain',
    report.mockLog.releaseTag === null
      ? `- \`${report.mockLog.file}\`: the mock's whole submission log, gzipped, beside this report (not committed)`
      : `- [\`${report.mockLog.file}\`](${REPO}/releases/download/${report.mockLog.releaseTag}/${report.mockLog.file}): the mock's whole submission log, a release asset (\`pnpm bigrun:publish\` uploads it)`,
    '',
  );
  return lines.join('\n');
}

/** One line naming the machine. */
export function environmentLine(env: Environment): string {
  return `${env.cpuModel}, ${env.cores} cores, ${env.ramGiB} GiB RAM, ${env.os}, Docker ${env.docker}, Node ${env.node}`;
}

/** What the index and the README take from a report. */
export function indexedRun(report: Report): IndexedRun {
  const m = report.measurements;
  return {
    dir: report.dir,
    kind: report.kind,
    verdict: report.verdict,
    gitSha: report.provenance.gitSha,
    startedAt: report.startedAt,
    headline: {
      events: report.events.total,
      completedCases: report.events.visits - report.unfinishedCases.length,
      totalSeconds: m.durationsSeconds.total,
      acceptedEventsPerSecond: m.throughput.acceptedEventsPerSecond,
      ingestP95Ms: m.ingestLatencyMs.p95,
      endToEndP95Seconds: m.endToEndSeconds.p95,
      realizedReadFaultRate: m.faults.reads.rate,
      realizedWriteFaultRate: m.faults.writes.rate,
    },
    environment: environmentLine(report.environment),
  };
}
