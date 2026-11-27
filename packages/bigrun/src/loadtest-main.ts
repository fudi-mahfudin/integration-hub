// `pnpm loadtest [--official] [--set path=value ...]`: the load test (#46) and
// its composition root. Brings the stack up as the big run commits it, with
// the mock SATUSEHAT and no faults, writes the event file the source simulator
// plans, runs k6 at the committed arrival rate, judges its summary against the
// committed thresholds, and writes the report. Exits 0 on PASS, 1 on FAIL and
// 2 when it refuses to run.
import { MockSatusehatClient } from '@integration-hub/mock-satusehat/client';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { eventFile, planBatch } from '@integration-hub/simulator';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { harnessEnv } from './harness-env.js';
import { judgeLoadTest } from './loadtest/judge.js';
import { k6Options } from './loadtest/k6.js';
import { publishLoadTestSection, updateLoadTestIndex } from './loadtest/publish.js';
import { indexedLoadTest, renderLoadTestReport, type LoadTestReport } from './loadtest/report.js';
import { loadLoadTestSettings, loadTestBatch, loadTestRequests, type LoadTestSettings } from './loadtest/settings.js';
import { checkTopology, officialGuard } from './preflight.js';
import { newRunDirectory, runDirectoryBase } from './run-directory.js';
import { loadSettings, SettingsError, type BigRunCommitments } from './settings.js';
import { captureEnvironment, COMMITMENTS_FILE, composeUp, inspectContainers, k6Version, readGitFacts, runK6 } from './system.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));

const env = harnessEnv;
/** Where k6 sends: it runs in compose, beside the hub service. */
const K6_HUB_URL = 'http://hub:3000/';
/** Where compose mounts the repository's `results/` in the `k6` container. */
const K6_RESULTS = '/results';

function refuse(reasons: readonly string[]): never {
  for (const reason of reasons) log(`refused: ${reason}`);
  process.exit(2);
}

let settings: LoadTestSettings;
let bigRun: BigRunCommitments;
try {
  const commitments: unknown = JSON.parse(await readFile(`${repoRoot}/${COMMITMENTS_FILE}`, 'utf8'));
  settings = loadLoadTestSettings(commitments, process.argv.slice(2));
  // The committed big run, unchanged: its topology, seed and event mix.
  bigRun = loadSettings(commitments, []).bigRun;
} catch (err) {
  if (err instanceof SettingsError) refuse([err.message]);
  throw err;
}
const { kind, loadTest, overrides } = settings;
log('load test settings', { kind, eventsPerSecond: loadTest.eventsPerSecond, warmUpSeconds: loadTest.warmUpSeconds, durationSeconds: loadTest.durationSeconds, overrides });

const git = await readGitFacts(repoRoot);
if (kind === 'official') {
  const problems = officialGuard(git);
  if (problems.length > 0) refuse(problems);
}

log('bringing the stack up');
await composeUp(repoRoot, { TRACE_SAMPLE_RATIO: String(bigRun.tracing.sampleRatio), RECONCILIATION_INTERVAL_MS: '0' });
const containers = await inspectContainers(repoRoot);
const topologyProblems = checkTopology(bigRun, containers, { hubUrl: new URL(env.BIGRUN_HUB_URL), mockUrl: new URL(env.BIGRUN_MOCK_URL) });
if (topologyProblems.length > 0) refuse(topologyProblems);
// Answers only if it is the mock, and the mock was just recreated: a fault seed means someone set faults since.
const mockReport = await new MockSatusehatClient(new URL(env.BIGRUN_MOCK_URL)).report();
if (mockReport.faultSeed !== null) refuse([`the mock has faults set (seed ${mockReport.faultSeed}); the load test runs with none`]);
const environment = await captureEnvironment(repoRoot, containers);
const version = await k6Version(repoRoot);

const startedAt = new Date();
const runId = startedAt.getTime().toString(36).toUpperCase();
const batch = loadTestBatch(bigRun, loadTest, runId);
const eventFileLines = eventFile(planBatch(await loadWorld(DEFAULT_WORLD_PATH), batch));
const requests = loadTestRequests(loadTest);
if (eventFileLines.length < requests.warmUp + requests.load) refuse([`the event file has ${eventFileLines.length} requests, and the run can send ${requests.warmUp + requests.load}`]);
const base = runDirectoryBase(startedAt, git.headSha);
const parent = kind === 'official' ? 'results/k6' : 'results/k6-unofficial';
const dir = await newRunDirectory(repoRoot, parent, kind === 'official' ? base : `${base}-${kind}`);
const ndjson = `${eventFileLines.map((line) => JSON.stringify({ idempotencyKey: line.idempotencyKey, body: line.body })).join('\n')}\n`;
await writeFile(`${dir.path}/events.ndjson`, ndjson);
const options = k6Options(loadTest);
await writeJson(`${dir.path}/k6-config.json`, { hubUrl: K6_HUB_URL, warmUpRequests: requests.warmUp, options });
const duplicates = eventFileLines.filter((line) => line.duplicate).length;
// The planned share in the requests the measured phase sends, if it sends one per arrival.
const measuredLines = eventFileLines.slice(requests.warmUp, requests.warmUp + requests.load);
const measuredDuplicateShare = measuredLines.filter((line) => line.duplicate).length / measuredLines.length;
log('event file written', { dir: dir.path, requests: eventFileLines.length, duplicates, measuredDuplicateShare });

log('running k6', { version });
const exitCode = await runK6(repoRoot, `${K6_RESULTS}/${parent.slice('results/'.length)}/${dir.name}`, env.BIGRUN_SOURCE_API_KEY);
const endedAt = new Date();
const summaryPath = `${dir.path}/k6-summary.json`;
const summary: unknown = existsSync(summaryPath) ? JSON.parse(await readFile(summaryPath, 'utf8')) : null;
const judgement = judgeLoadTest(loadTest, exitCode, summary);

const report: LoadTestReport = {
  dir: dir.name,
  kind,
  verdict: judgement.verdict,
  runId,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  provenance: { gitSha: git.headSha, uncommitted: git.uncommitted, commitmentsSha256: git.commitments.sha256, commitmentsCommit: git.commitments.lastCommit },
  overrides,
  loadTest,
  eventFile: {
    file: 'events.ndjson',
    seed: batch.seed,
    visits: batch.visits,
    requests: eventFileLines.length,
    duplicates,
    measuredDuplicateShare,
    sha256: createHash('sha256').update(ndjson).digest('hex'),
  },
  k6: { version, exitCode, preAllocatedVUs: options.scenarios.load.preAllocatedVUs, maxVUs: options.scenarios.load.maxVUs },
  checks: judgement.checks,
  measurements: judgement.measurements,
  environment,
};
await writeJson(`${dir.path}/report.json`, { ...report, summary: indexedLoadTest(report) });
await writeFile(`${dir.path}/report.md`, renderLoadTestReport(report));
if (kind === 'official') {
  const indexPath = `${repoRoot}results/k6/INDEX.md`;
  await writeFile(indexPath, updateLoadTestIndex(existsSync(indexPath) ? await readFile(indexPath, 'utf8') : null, indexedLoadTest(report)));
  const readmePath = `${repoRoot}README.md`;
  await writeFile(readmePath, publishLoadTestSection(await readFile(readmePath, 'utf8'), indexedLoadTest(report)));
  log('published to results/k6/INDEX.md and the README; commit them with the run, pass or fail');
}
for (const check of judgement.checks.filter((c) => !c.pass)) log(`FAIL ${check.name}: expected ${check.expected}, got ${check.actual}`);
log(`load test ${judgement.verdict}`, { report: `${dir.path}/report.md` });
process.exitCode = judgement.verdict === 'PASS' ? 0 : 1;

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
