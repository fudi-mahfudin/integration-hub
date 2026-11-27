// Publishing official load tests: `results/k6/INDEX.md` and the README's load
// test section. Only official runs are ever listed or published, pass or fail.
import { z } from 'zod';
import { PublishError, REPO } from '../publish.js';

/** What the index and the README show of one load test: the `summary` of its `report.json`. */
export const indexedLoadTestSchema = z.object({
  /** Its directory under `results/k6/`, `<YYYY-MM-DD>-<shortsha>`. */
  dir: z.string(),
  kind: z.enum(['official', 'unofficial']),
  verdict: z.enum(['PASS', 'FAIL']),
  gitSha: z.string(),
  startedAt: z.string(),
  /** The measured phase; null where k6 wrote no readable summary. */
  headline: z.object({
    eventsPerSecond: z.number(),
    requestsPerSecond: z.number().nullable(),
    ingestP95Ms: z.number().nullable(),
    ingestP99Ms: z.number().nullable(),
    non2xxRate: z.number().nullable(),
  }),
  /** One line: CPU, cores, RAM, OS, Docker, Node. */
  environment: z.string(),
});

/** What the index and the README show of one load test. */
export type IndexedLoadTest = z.infer<typeof indexedLoadTestSchema>;

const START = '<!-- loadtest:start -->';
const END = '<!-- loadtest:end -->';
const startedAtMinute = (run: IndexedLoadTest) => run.startedAt.slice(0, 16).replace('T', ' ');
const msOrNa = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value)} ms`);
const percentOrNa = (rate: number | null) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(3)}%`);
const INDEX_HEADER = [
  '# Load test results',
  '',
  'Every official load test (`pnpm loadtest --official`), pass or fail, newest first. The commitments they are judged by: `loadTest` in [`bigrun.commitments.json`](../../bigrun.commitments.json).',
  '',
  '| Run | Verdict | Started (UTC) | Git SHA | Requests/s | p95 | p99 | Non-2xx |',
  '|---|---|---|---|---|---|---|---|',
];

function requireOfficial(run: IndexedLoadTest): void {
  if (run.kind !== 'official') throw new PublishError(`only official load tests are published, and ${run.dir} is an ${run.kind} run`);
}

/** The README with the text between `<!-- loadtest:start -->` and `<!-- loadtest:end -->` replaced by the run's summary; nothing else changes. */
export function publishLoadTestSection(readme: string, run: IndexedLoadTest): string {
  requireOfficial(run);
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new PublishError(`the README needs a ${START} … ${END} section to publish into`);
  const h = run.headline;
  const section = [
    `Latest official load test: **${run.verdict}**, [\`${run.dir}\`](results/k6/${run.dir}/report.md), started ${startedAtMinute(run)} UTC at \`${run.gitSha.slice(0, 7)}\`.`,
    '',
    '| Measured phase | |',
    '|---|---|',
    `| Arrival rate, committed / sent | ${h.eventsPerSecond} / ${h.requestsPerSecond ?? 'n/a'} events/s |`,
    `| Ingest p95 / p99 (client) | ${msOrNa(h.ingestP95Ms)} / ${msOrNa(h.ingestP99Ms)} |`,
    `| Non-2xx rate | ${percentOrNa(h.non2xxRate)} |`,
    '',
    `Environment: ${run.environment}.`,
    '',
    'Every official load test: [results/k6/INDEX.md](results/k6/INDEX.md).',
  ].join('\n');
  return `${readme.slice(0, start + START.length)}\n${section}\n${readme.slice(end)}`;
}

/** The index (`results/k6/INDEX.md`, or null when there is none yet) with the run listed, newest first; a rerun of a directory replaces its row. */
export function updateLoadTestIndex(index: string | null, run: IndexedLoadTest): string {
  requireOfficial(run);
  const rows = (index ?? '').split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Run ') && !line.startsWith(`| ${run.dir} |`));
  const h = run.headline;
  const row = `| ${run.dir} | [${run.verdict}](${run.dir}/report.md) | ${startedAtMinute(run)} | [\`${run.gitSha.slice(0, 7)}\`](${REPO}/commit/${run.gitSha}) | ${h.requestsPerSecond ?? 'n/a'} | ${msOrNa(h.ingestP95Ms)} | ${msOrNa(h.ingestP99Ms)} | ${percentOrNa(h.non2xxRate)} |`;
  const sorted = [row, ...rows].toSorted((a, b) => (b.split('|')[1] ?? '').localeCompare(a.split('|')[1] ?? ''));
  return `${[...INDEX_HEADER, ...sorted].join('\n')}\n`;
}
