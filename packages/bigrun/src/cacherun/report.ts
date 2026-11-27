// A Cache run's report: `report.json` holds everything, `report.md` is its
// reading copy; `results/cache/INDEX.md` and the README list official runs.
import { indexWithRow, replaceSection, requireOfficial, startedAtMinute } from '../publish.js';
import { provenanceLines, type Provenance } from '../report.js';
import type { Override } from '../settings.js';
import type { Environment } from '../system.js';
import { median, type CacheDecision } from './judge.js';
import type { RunMeasurement } from './measure.js';
import type { CacheRunSettings } from './settings.js';

/** Everything a Cache run found: `report.json`. */
export interface CacheRunReport {
  /** Its directory under `results/cache/` (or `results/cache-unofficial/`). */
  dir: string;
  /** Official, or not: only official runs are listed and published. */
  kind: CacheRunSettings['kind'];
  /** ISO 8601 UTC. */
  startedAt: string;
  /** ISO 8601 UTC. */
  endedAt: string;
  /** The tree and commitments file it ran from. */
  provenance: Provenance;
  /** Committed values this run replaced (`--set` under `cacheRun`); a run with any is not official. */
  overrides: Override[];
  /** The visits each run sent: the big run's, or the CI visits with `--ci`. */
  visitsPerRun: number;
  /** The commitments it ran and was judged by. */
  cacheRun: CacheRunSettings['cacheRun'];
  /** Every run's measurements, in schedule order. */
  runs: RunMeasurement[];
  /** Each cache's judgement against the bar. */
  decisions: CacheDecision[];
  /** The machine of its first run. */
  environment: Environment;
}

const fixed = (value: number | null, digits: number) => (value === null ? 'n/a' : value.toFixed(digits));
const percent = (share: number | null) => (share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`);

/** What a decision means for the code: a cache that misses bar 1 or 2 is removed; one that clears both still needs bar 3. */
export function decisionText(decision: CacheDecision): string {
  return decision.measuredBarsPass
    ? 'clears bars 1 and 2: stays if the official big run passes with it on (bar 3)'
    : 'misses the bar: removed from the code, this result kept';
}

/** The report as Markdown, for `report.md`. */
export function renderCacheRunReport(report: CacheRunReport): string {
  const { cacheRun } = report;
  const arms = cacheRun.arms.map((arm) => {
    const runs = report.runs.filter((r) => r.arm === arm);
    const med = (values: (number | null)[]) => median(values.filter((v): v is number => v !== null));
    return {
      arm,
      runs: runs.length,
      reads: med(runs.map((r) => r.upstreamReadsPerCompletedCase)),
      p50: med(runs.map((r) => r.endToEndSeconds.p50)),
      p95s: runs.map((r) => r.endToEndSeconds.p95),
      attemptP95: med(runs.map((r) => r.attemptSeconds.p95)),
      drain: med(runs.map((r) => r.drainSeconds)),
    };
  });
  const env = report.environment;
  return [
    `# Cache run ${report.dir}`,
    '',
    `**${report.kind === 'official' ? 'Official' : 'Unofficial'} run**, ${report.startedAt} → ${report.endedAt}.`,
    report.overrides.length > 0 ? `Overrides (never official): ${report.overrides.map((o) => `\`${o.path}=${JSON.stringify(o.value)}\``).join(', ')}.` : '',
    '',
    `Each run: the big run's event mix at ${cacheRun.eventsPerSecond} events/s, ${report.visitsPerRun.toLocaleString('en-US')} visits, no faults, the big run's topology, from an empty Postgres and Redis. ` +
      `The mock answers every read ${cacheRun.mockLatencyMs.reads} ms and every write ${cacheRun.mockLatencyMs.writes} ms late: **assumed constants, not sandbox measurements**. ` +
      `Arms ${cacheRun.arms.map((a) => `"${a}"`).join(', ')}, ${cacheRun.runsPerArm}× each, ${cacheRun.order}.`,
    '',
    '## Decisions',
    '',
    '| Cache | Against | Reads per case (median, without → with) | Bar 1: ≥ ' +
      percent(cacheRun.barToStay.upstreamReadsPerCompletedCaseReduction) +
      ' fewer | e2e p95 (median, without → with) | Spread (larger arm) | Bar 2: ≥ ' +
      percent(cacheRun.barToStay.medianE2eCaseP95Improvement) +
      ' and > spread | Outcome |',
    '|---|---|---|---|---|---|---|---|',
    ...report.decisions.map(
      (d) =>
        `| \`${d.cache}\` | ${d.against} | ${fixed(d.upstreamReads.medianWithout, 2)} → ${fixed(d.upstreamReads.medianWith, 2)} | ${percent(d.upstreamReads.reduction)} ${d.upstreamReads.pass ? 'PASS' : 'FAIL'} | ${fixed(d.endToEndP95.medianWithoutSeconds, 1)} → ${fixed(d.endToEndP95.medianWithSeconds, 1)} s | ${fixed(d.endToEndP95.spreadSeconds, 1)} s | ${percent(d.endToEndP95.improvement)} ${d.endToEndP95.pass ? 'PASS' : 'FAIL'} | ${decisionText(d)} |`,
    ),
    '',
    'Bar 2 compares the median of each arm\'s per-run e2e p95. The commitment doesn\'t say which arm\'s max–min spread the improvement must exceed, so it must exceed both. ' +
      'Bar 3 (the official big run passes with the cache on) is judged by that run: see [results/bigrun/INDEX.md](../../bigrun/INDEX.md).',
    '',
    '## Arms',
    '',
    '| Arm | Runs | Upstream reads per completed case | e2e p50 | e2e p95 per run | Attempt p95 | Drain |',
    '|---|---|---|---|---|---|---|',
    ...arms.map(
      (a) =>
        `| ${a.arm} | ${a.runs} | ${fixed(a.reads, 2)} | ${fixed(a.p50, 1)} s | ${a.p95s.map((p) => fixed(p, 1)).join(' / ')} s | ${fixed(a.attemptP95 === null ? null : a.attemptP95 * 1000, 0)} ms | ${fixed(a.drain, 0)} s |`,
    ),
    '',
    'Medians over the arm\'s runs.',
    '',
    '## Runs',
    '',
    '| # | Arm | Big-run verdict | Completed cases | Reads per case | Hit ratio patient / practitioner | e2e p50 / p95 | Attempt p50 / p95 | Drain / total |',
    '|---|---|---|---|---|---|---|---|---|',
    ...report.runs.map(
      (r) =>
        `| ${r.run} | ${r.arm} | ${r.verdict}${r.failedInvariants.length > 0 ? ` (${r.failedInvariants.join('; ')})` : ''} | ${r.completedCases} | ${fixed(r.upstreamReadsPerCompletedCase, 2)} | ${percent(r.hitRatio.ihs_patient)} / ${percent(r.hitRatio.ihs_practitioner)} | ${fixed(r.endToEndSeconds.p50, 1)} / ${fixed(r.endToEndSeconds.p95, 1)} s | ${fixed(r.attemptSeconds.p50 === null ? null : r.attemptSeconds.p50 * 1000, 0)} / ${fixed(r.attemptSeconds.p95 === null ? null : r.attemptSeconds.p95 * 1000, 0)} ms | ${r.drainSeconds.toFixed(0)} / ${r.totalSeconds.toFixed(0)} s |`,
    ),
    '',
    'Reads are the GET requests the mock received (FHIR searches, KFA lookups). The hit ratio is hits over the requests that read the cache. The big-run verdict is information: faults are off, and the bar doesn\'t read it.',
    '',
    '## Environment',
    '',
    `- ${env.cpuModel}, ${env.cores} cores, ${env.ramGiB} GiB RAM, ${env.os}`,
    `- Node ${env.node}, Docker ${env.docker} (${env.dockerCpus} CPUs, ${env.dockerRamGiB} GiB), Compose ${env.compose}`,
    `- ${env.workerProcesses} worker processes; limits: ${env.containerLimits.map((c) => `${c.service} ${c.cpus ?? '∞'} CPU / ${c.memoryBytes === null ? '∞' : `${Math.round(c.memoryBytes / 1024 ** 2)}m`}`).join(', ')}`,
    '',
    ...provenanceLines(report.provenance),
  ].join('\n');
}

const INDEX_HEADER = [
  '# Cache run results',
  '',
  'Every official Cache run (`pnpm cacherun --official`), pass or fail, newest first. The commitments they are judged by: `cacheRun` in [`bigrun.commitments.json`](../../bigrun.commitments.json).',
  '',
  '| Run | Report | Started (UTC) | Git SHA | `ihs_practitioner` | `ihs_patient` |',
  '|---|---|---|---|---|---|',
];

const outcomeOf = (report: CacheRunReport, cache: CacheDecision['cache']) => {
  const decision = report.decisions.find((d) => d.cache === cache);
  return decision === undefined ? 'not judged' : decision.measuredBarsPass ? 'clears bars 1–2' : 'misses the bar';
};

/** The index (`results/cache/INDEX.md`, or null when there is none yet) with the run listed, newest first. */
export function updateCacheIndex(index: string | null, report: CacheRunReport): string {
  requireOfficial(report);
  const row = `| ${report.dir} | [report](${report.dir}/report.md) | ${startedAtMinute(report.startedAt)} | \`${report.provenance.gitSha.slice(0, 7)}\` | ${outcomeOf(report, 'ihs_practitioner')} | ${outcomeOf(report, 'ihs_patient')} |`;
  return indexWithRow(index, INDEX_HEADER, report.dir, row);
}

/** The README with the `<!-- cacherun:start -->` … `<!-- cacherun:end -->` section showing the run's decisions. */
export function readmeWithCacheRun(readme: string, report: CacheRunReport): string {
  requireOfficial(report);
  const section = [
    `Latest official Cache run: [${report.dir}](results/cache/${report.dir}/report.md), ${startedAtMinute(report.startedAt)} UTC, at \`${report.provenance.gitSha.slice(0, 7)}\`.`,
    '',
    ...report.decisions.map(
      (d) =>
        `- \`${d.cache}\`: upstream reads per case ${percent(d.upstreamReads.reduction)} fewer, e2e p95 ${percent(d.endToEndP95.improvement)} better (spread ${fixed(d.endToEndP95.spreadSeconds, 1)} s): ${decisionText(d)}.`,
    ),
    '',
    'Every official Cache run: [results/cache/INDEX.md](results/cache/INDEX.md).',
  ].join('\n');
  return replaceSection(readme, { start: '<!-- cacherun:start -->', end: '<!-- cacherun:end -->' }, section);
}
