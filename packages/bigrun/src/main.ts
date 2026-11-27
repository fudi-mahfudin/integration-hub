// `pnpm bigrun [--official | --ci] [--set path=value ...]`: the big-run harness
// and its composition root. Brings the stack up as committed, writes the
// manifest, sets the faults, drives the simulator, judges both sides, and
// writes the report. Exits 0 on PASS, 1 on FAIL, 2 when it refuses to run.
import { MockSatusehatClient, type LogEntry, type MockReport } from '@integration-hub/mock-satusehat/client';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { planBatch, runBatch, type BatchOptions, type Plan } from '@integration-hub/simulator';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { faultRulesFor } from './fault-rules.js';
import { readCaseViews } from './hub-cases.js';
import { judge } from './judge.js';
import { manifestFor } from './manifest.js';
import { checkTopology, officialGuard } from './preflight.js';
import { queryPrometheus } from './prometheus.js';
import { updateIndex } from './publish.js';
import { reconcileAfterDrain } from './reconciliation.js';
import { newRunDirectory, runDirectoryBase } from './run-directory.js';
import { indexedRun, renderReport, type Report } from './report.js';
import { loadSettings, SettingsError, type BigRunCommitments, type Settings } from './settings.js';
import { captureEnvironment, COMMITMENTS_FILE, composeUp, inspectContainers, readGitFacts } from './system.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));

/** Where the harness sends, read from the environment once; the defaults are compose's published ports and public development keys. */
const env = z
  .object({
    BIGRUN_HUB_URL: z.url().default('http://localhost:3000/'),
    BIGRUN_MOCK_URL: z.url().default('http://localhost:3001/'),
    BIGRUN_PROMETHEUS_URL: z.url().default('http://localhost:9090/'),
    BIGRUN_SOURCE_API_KEY: z.string().min(1).default('dev-source-key'),
    BIGRUN_ADMIN_API_KEY: z.string().min(1).default('dev-admin-key'),
  })
  .parse(process.env);
const hubUrl = new URL(env.BIGRUN_HUB_URL);
const mockUrl = new URL(env.BIGRUN_MOCK_URL);

/** Ends the process without running: exit 2, each reason on its own line. */
function refuse(reasons: readonly string[]): never {
  for (const reason of reasons) log(`refused: ${reason}`);
  process.exit(2);
}

let settings: Settings;
try {
  settings = loadSettings(JSON.parse(await readFile(`${repoRoot}/${COMMITMENTS_FILE}`, 'utf8')), process.argv.slice(2));
} catch (err) {
  if (err instanceof SettingsError) refuse([err.message]);
  throw err;
}
const { bigRun, kind, overrides } = settings;
log('big run settings', { kind, visits: bigRun.events.visits, events: bigRun.events.total, overrides });

const git = await readGitFacts(repoRoot);
if (kind === 'official') {
  const problems = officialGuard(git);
  if (problems.length > 0) refuse(problems);
}

log('bringing the stack up');
await composeUp(repoRoot, { TRACE_SAMPLE_RATIO: String(bigRun.tracing.sampleRatio), RECONCILIATION_INTERVAL_MS: '0' });
const containers = await inspectContainers(repoRoot);
const topologyProblems = checkTopology(bigRun, containers, { hubUrl, mockUrl });
if (topologyProblems.length > 0) refuse(topologyProblems);
const mock = new MockSatusehatClient(mockUrl);
// Answers only if it is the mock: the real platform has no `/__mock/report`.
await mock.report();
const environment = await captureEnvironment(repoRoot, containers);

const startedAt = new Date();
const runId = startedAt.getTime().toString(36).toUpperCase();
const plan = planBatch(await loadWorld(DEFAULT_WORLD_PATH), batchOptions(bigRun, runId));
checkPlan(plan, bigRun);
const dir = await runDirectory(startedAt, git.headSha, kind);
const manifest = manifestFor(plan, settings, new Date());
await writeJson(`${dir.path}/manifest.json`, manifest);
log('manifest written', { dir: dir.path });

const faults = faultRulesFor(bigRun);
await mock.setFaults(faults);
log('faults set', { seed: faults.seed, rules: faults.rules.length });

const minute = 60_000;
const batch = await runBatch(
  plan,
  { baseUrl: hubUrl, apiKey: env.BIGRUN_SOURCE_API_KEY },
  {
    pollIntervalMs: bigRun.completion.pollIntervalSeconds * 1000,
    noProgressTimeoutMs: bigRun.completion.noProgressFailFastMinutes * minute,
    deadlineMs: bigRun.completion.hardDeadlineMinutes * minute,
    report: (line) => log(line),
  },
);
const endedAt = new Date();
log('waiting ended', { ending: batch.ending, problems: batch.problems.length });

const caseReads = await readCaseViews({ baseUrl: hubUrl, adminApiKey: env.BIGRUN_ADMIN_API_KEY }, batch.cases.map((c) => c.caseId));
// A mock that can't be read leaves the log empty, so every visit's mock-side check fails: the FAIL report is still written.
let mockLog: LogEntry[] = [];
let mockReport: MockReport = { faultSeed: null, duplicates: [], outOfOrder: [], overlap: [] };
let mockReadError: string | null = null;
try {
  mockLog = await mock.logNdjson();
  mockReport = await mock.report();
} catch (err) {
  mockReadError = err instanceof Error ? err.message : String(err);
  log('reading the mock failed; every mock-side check fails', { error: mockReadError });
}
const judgement = judge({ bigRun, visits: manifest.visits, batch, cases: caseReads.views, mockLog, mockReport });
log('judged', { verdict: judgement.verdict });

log('reconciling after the drain (information only)');
const reconciliation = await reconcileAfterDrain(hubUrl, env.BIGRUN_ADMIN_API_KEY, batch.startedAt, 10 * minute);
const prometheus = await queryPrometheus(new URL(env.BIGRUN_PROMETHEUS_URL), endedAt, (endedAt.getTime() - batch.startedAt.getTime()) / 1000);

const report: Report = {
  dir: dir.name,
  kind,
  verdict: judgement.verdict,
  runId,
  startedAt: batch.startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  ending: batch.ending,
  provenance: { gitSha: git.headSha, uncommitted: git.uncommitted, commitmentsSha256: git.commitments.sha256, commitmentsCommit: git.commitments.lastCommit },
  overrides,
  faultSeed: faults.seed,
  events: { visits: bigRun.events.visits, total: bigRun.events.total },
  invariants: judgement.invariants,
  unfinishedCases: judgement.unfinishedCases,
  unreadableCases: caseReads.unreadable,
  mockReadError,
  mockSideMismatches: judgement.mockSideMismatches,
  simulatorProblems: batch.problems.slice(0, 100),
  measurements: judgement.measurements,
  prometheus,
  reconciliation,
  environment,
  mockLog: { file: 'mock-log.ndjson.gz', releaseTag: kind === 'official' ? `bigrun-${dir.name}` : null },
};
// `summary` is what `pnpm bigrun:publish` reads back, through its schema.
await writeJson(`${dir.path}/report.json`, { ...report, summary: indexedRun(report) });
await writeFile(`${dir.path}/report.md`, renderReport(report));
await writeJson(`${dir.path}/mock-report.json`, mockReport);
await writeFile(`${dir.path}/${report.mockLog.file}`, gzipSync(mockLog.map((entry) => JSON.stringify(entry)).join('\n')));
if (kind === 'official') {
  const indexPath = `${repoRoot}/results/bigrun/INDEX.md`;
  await writeFile(indexPath, updateIndex(existsSync(indexPath) ? await readFile(indexPath, 'utf8') : null, indexedRun(report)));
}
for (const check of judgement.invariants.filter((c) => !c.pass)) log(`FAIL ${check.name}: expected ${check.expected}, got ${check.actual}`);
log(`big run ${judgement.verdict}`, { report: `${dir.path}/report.md` });
process.exitCode = judgement.verdict === 'PASS' ? 0 : 1;

/** The simulator's batch for the committed run. */
function batchOptions(b: BigRunCommitments, id: string): BatchOptions {
  return {
    seed: b.seed,
    runId: id,
    visits: b.events.visits,
    eventsPerSecond: b.arrival.eventsPerSecond,
    outOfOrder: { share: b.eventMix.outOfOrder, delayMs: b.eventMix.outOfOrderHoldSeconds * 1000 },
    substitutionShare: b.eventMix.substitution,
    fallbackLookupShare: b.eventMix.fallbackPersonLookup,
    duplicates: {
      perEvent: b.events.duplicates / b.events.uniqueEvents,
      concurrent: b.duplicateTiming.concurrent,
      delayed: b.duplicateTiming.delayed,
      late: b.duplicateTiming.late,
      delayedWindowMs: { min: b.duplicateTiming.delayedWindowSeconds.min * 1000, max: b.duplicateTiming.delayedWindowSeconds.max * 1000 },
    },
  };
}

/** Refuses a plan whose counts are not the committed ones, before anything is sent. */
function checkPlan(planned: Plan, b: BigRunCommitments): void {
  const duplicates = planned.sends.filter((s) => s.duplicate !== null).length;
  if (planned.sends.length !== b.events.uniqueEvents || duplicates !== b.events.duplicates) {
    refuse([`the plan has ${planned.sends.length} events and ${duplicates} duplicates, committed ${b.events.uniqueEvents} and ${b.events.duplicates}`]);
  }
}

/**
 * A new directory for the run: `results/bigrun/<YYYY-MM-DD>-<shortsha>` for
 * an official run, `results/bigrun-unofficial/…-<kind>` (never committed) for
 * any other.
 */
function runDirectory(at: Date, sha: string, runKind: Settings['kind']): Promise<{ name: string; path: string }> {
  const base = runDirectoryBase(at, sha);
  return runKind === 'official' ? newRunDirectory(repoRoot, 'results/bigrun', base) : newRunDirectory(repoRoot, 'results/bigrun-unofficial', `${base}-${runKind}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
