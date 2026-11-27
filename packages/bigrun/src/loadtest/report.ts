// A load test's report: `report.json` holds everything, `report.md` is its reading copy.
import { environmentLine, provenanceLines, type Provenance } from '../report.js';
import type { Override } from '../settings.js';
import type { Environment } from '../system.js';
import type { LoadTestJudgement } from './judge.js';
import type { IndexedLoadTest } from './publish.js';
import type { LoadTestCommitments, LoadTestKind } from './settings.js';

/** Everything a load test found: `report.json`. */
export interface LoadTestReport {
  /** Its directory's name, under `results/k6/` or `results/k6-unofficial/`. */
  dir: string;
  kind: LoadTestKind;
  verdict: LoadTestJudgement['verdict'];
  /** Prefixes the event file's visit ids and idempotency keys. */
  runId: string;
  /** When the event file was planned, ISO 8601. */
  startedAt: string;
  /** When k6 ended, ISO 8601. */
  endedAt: string;
  provenance: Provenance;
  /** Committed values this run replaced (`--set`); a run with any is not official. */
  overrides: Override[];
  /** The `loadTest` commitments the run ran with, after any overrides. */
  loadTest: LoadTestCommitments;
  /** The event file the simulator planned; it is not committed, and the seed and run id plan it again. */
  eventFile: {
    file: string;
    seed: number;
    visits: number;
    requests: number;
    duplicates: number;
    /** The duplicates' share of the requests the measured phase sends, if it sends one per arrival. */
    measuredDuplicateShare: number;
    sha256: string;
  };
  /** The k6 that ran (`k6 version`), and how its run ended: 0, or 99 when a threshold was crossed; anything else is k6 failing. */
  k6: { version: string; exitCode: number; preAllocatedVUs: number; maxVUs: number };
  checks: LoadTestJudgement['checks'];
  measurements: LoadTestJudgement['measurements'];
  /** The machine and the container limits the run ran with. */
  environment: Environment;
}

/** The report as Markdown, for `report.md`. */
export function renderLoadTestReport(report: LoadTestReport): string {
  const committed = report.loadTest;
  const lines: string[] = [
    `# Load test ${report.dir}: ${report.verdict}`,
    '',
    report.kind === 'official'
      ? 'An **official** load test: the committed one, unchanged, from a clean tree.'
      : '**Not an official load test.** It is never published.',
    '',
  ];
  if (report.overrides.length > 0) {
    lines.push('> [!WARNING]', '> **Overrides.** This run replaced committed values, so it is not official:', '>');
    for (const o of report.overrides) lines.push(`> - \`${o.path}\` = \`${JSON.stringify(o.value)}\``);
    lines.push('');
  }
  lines.push(
    `${report.k6.version}: \`${committed.executor}\` at ${committed.eventsPerSecond} events/s: a ${committed.warmUpSeconds}s warm-up, then the measured phase of ${committed.durationSeconds}s, against the hub service with the mock SATUSEHAT and no faults. Run \`${report.runId}\`, started ${report.startedAt}, ended ${report.endedAt}.`,
    '',
    ...provenanceLines(report.provenance),
    '## Checks',
    '',
    '| Check | Expected | Actual | |',
    '|---|---|---|---|',
    ...report.checks.map((c) => `| ${c.name} | ${c.expected} | ${c.actual} | ${c.pass ? 'PASS' : '**FAIL**'} |`),
    '',
  );
  if (report.k6.exitCode !== 0 && report.k6.exitCode !== 99) lines.push(`**k6 failed** with exit code ${report.k6.exitCode}; its output is in the harness log.`, '');
  const measured = report.measurements;
  if (measured !== null) {
    const latency = measured.latencyMs;
    lines.push(
      '## Measurements',
      '',
      'Information only, beside the checks above.',
      '',
      '| Measurement | Value |',
      '|---|---|',
      `| Requests, measured phase | ${measured.requests.toLocaleString('en-US')} (${measured.requestsPerSecond.toFixed(1)}/s) |`,
      `| Ingest latency min / median / avg / p90 / p95 / p99 / max, client | ${[latency.min, latency.med, latency.avg, latency.p90, latency.p95, latency.p99, latency.max].map((ms) => ms.toFixed(1)).join(' / ')} ms |`,
      `| Non-2xx, measured phase | ${measured.non2xx.count.toLocaleString('en-US')} (${(measured.non2xx.rate * 100).toFixed(3)}%) |`,
      `| Replayed answers (\`Idempotent-Replayed: true\`), both phases | ${measured.replayed.toLocaleString('en-US')} |`,
      `| Dropped arrivals, both phases | ${measured.droppedIterations} |`,
      `| VUs allocated at most, both phases / pre-allocated / allowed, each phase | ${measured.vusMax} / ${report.k6.preAllocatedVUs} / ${report.k6.maxVUs} |`,
      `| k6 run time | ${measured.testRunSeconds.toFixed(1)} s |`,
      '',
    );
  }
  const file = report.eventFile;
  const env = report.environment;
  lines.push(
    '## Event file',
    '',
    `Planned by the source simulator from the world dataset with seed ${file.seed} and the big run's event mix: ${file.visits.toLocaleString('en-US')} visits, ${file.requests.toLocaleString('en-US')} requests, ${file.duplicates.toLocaleString('en-US')} of them duplicates (${((file.duplicates / file.requests) * 100).toFixed(1)}%; ${(file.measuredDuplicateShare * 100).toFixed(1)}% of the measured phase's share of the file). SHA-256 \`${file.sha256}\`. \`${file.file}\` stays beside this report and is not committed.`,
    '',
    '## Environment',
    '',
    `- ${environmentLine(env)}`,
    `- Docker has ${env.dockerCpus} CPUs and ${env.dockerRamGiB} GiB; compose ${env.compose}; ${env.workerProcesses} worker processes; k6 runs in Docker beside the stack, without limits`,
    `- Container limits: ${env.containerLimits.map((c) => `${c.service} ${c.cpus ?? '∞'} CPU / ${c.memoryBytes === null ? '∞' : `${Math.round(c.memoryBytes / 1024 / 1024)} MiB`}`).join(', ')}`,
    '',
    '## Files',
    '',
    '- `k6-config.json`: the options and target k6 ran with',
    '- `k6-summary.json`: k6\'s whole end-of-test summary',
    '',
  );
  return lines.join('\n');
}

/** What the index and the README take from a report. */
export function indexedLoadTest(report: LoadTestReport): IndexedLoadTest {
  const measured = report.measurements;
  return {
    dir: report.dir,
    kind: report.kind,
    verdict: report.verdict,
    gitSha: report.provenance.gitSha,
    startedAt: report.startedAt,
    headline: {
      eventsPerSecond: report.loadTest.eventsPerSecond,
      requestsPerSecond: measured?.requestsPerSecond ?? null,
      ingestP95Ms: measured?.latencyMs.p95 ?? null,
      ingestP99Ms: measured?.latencyMs.p99 ?? null,
      non2xxRate: measured?.non2xx.rate ?? null,
    },
    environment: environmentLine(report.environment),
  };
}
