// Publishing official runs: the results index and the README's big run
// section. Only official runs are ever listed or published, pass or fail.
import type { RunKind } from './settings.js';

/** What the index and the README show of one run, taken from its report. */
export interface IndexedRun {
  /** Its directory under `results/bigrun/`, `<YYYY-MM-DD>-<shortsha>`. */
  dir: string;
  kind: RunKind;
  verdict: 'PASS' | 'FAIL';
  gitSha: string;
  startedAt: string;
  headline: {
    events: number;
    completedCases: number;
    totalSeconds: number;
    acceptedEventsPerSecond: number;
    ingestP95Ms: number | null;
    endToEndP95Seconds: number | null;
    realizedReadFaultRate: number;
    realizedWriteFaultRate: number;
  };
  /** One line: CPU, cores, RAM, OS, Docker, Node. */
  environment: string;
}

/** Thrown when a run can't be published. */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

const START = '<!-- bigrun:start -->';
const END = '<!-- bigrun:end -->';
const REPO = 'https://github.com/fudi-mahfudin/integration-hub';
const INDEX_HEADER = [
  '# Big run results',
  '',
  'Every official run (`pnpm bigrun --official`), pass or fail, newest first. The commitments they are judged by: [`bigrun.commitments.json`](../../bigrun.commitments.json).',
  '',
  '| Run | Verdict | Started (UTC) | Git SHA | Events | Total |',
  '|---|---|---|---|---|---|',
];

function requireOfficial(run: IndexedRun): void {
  if (run.kind !== 'official') throw new PublishError(`only official runs are published, and ${run.dir} is a ${run.kind} run`);
}

/**
 * The README with the text between `<!-- bigrun:start -->` and
 * `<!-- bigrun:end -->` replaced by the run's summary: verdict, headline
 * numbers, environment, and links to its report, the index and the
 * commitments' history. Nothing outside the markers changes.
 */
export function publishSection(readme: string, run: IndexedRun): string {
  requireOfficial(run);
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new PublishError(`the README needs a ${START} … ${END} section to publish into`);
  const h = run.headline;
  const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;
  const section = [
    `Latest official run: **${run.verdict}**, [\`${run.dir}\`](results/bigrun/${run.dir}/report.md), started ${run.startedAt.slice(0, 16).replace('T', ' ')} UTC at \`${run.gitSha.slice(0, 7)}\`.`,
    '',
    '| | |',
    '|---|---|',
    `| Events sent | ${h.events.toLocaleString('en-US')} |`,
    `| Cases completed | ${h.completedCases.toLocaleString('en-US')} |`,
    `| Total duration | ${(h.totalSeconds / 60).toFixed(1)} min |`,
    `| Accepted events/s | ${h.acceptedEventsPerSecond.toFixed(1)} |`,
    `| Ingest p95 (client) | ${h.ingestP95Ms === null ? 'n/a' : `${Math.round(h.ingestP95Ms)} ms`} |`,
    `| End-to-end per case p95 | ${h.endToEndP95Seconds === null ? 'n/a' : `${h.endToEndP95Seconds.toFixed(1)} s`} |`,
    `| Realized fault rate, reads / writes | ${percent(h.realizedReadFaultRate)} / ${percent(h.realizedWriteFaultRate)} |`,
    '',
    `Environment: ${run.environment}.`,
    '',
    `Every official run: [results/bigrun/INDEX.md](results/bigrun/INDEX.md). The commitments and their history: [history of \`bigrun.commitments.json\`](${REPO}/commits/main/bigrun.commitments.json).`,
  ].join('\n');
  return `${readme.slice(0, start + START.length)}\n${section}\n${readme.slice(end)}`;
}

/** The index (`results/bigrun/INDEX.md`, or null when there is none yet) with the run listed, newest first; a rerun of a directory replaces its row. */
export function updateIndex(index: string | null, run: IndexedRun): string {
  requireOfficial(run);
  const rows = (index ?? '').split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Run ') && !line.startsWith(`| ${run.dir} |`));
  const row = `| ${run.dir} | [${run.verdict}](${run.dir}/report.md) | ${run.startedAt.slice(0, 16).replace('T', ' ')} | \`${run.gitSha.slice(0, 7)}\` | ${run.headline.events.toLocaleString('en-US')} | ${(run.headline.totalSeconds / 60).toFixed(1)} min |`;
  const sorted = [row, ...rows].toSorted((a, b) => (b.split('|')[1] ?? '').localeCompare(a.split('|')[1] ?? ''));
  return `${[...INDEX_HEADER, ...sorted].join('\n')}\n`;
}
