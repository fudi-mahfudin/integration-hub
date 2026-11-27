// `pnpm cacherun [--official | --ci] [--set path=value ...]`: the Cache run
// harness (#47) and its composition root. Runs the committed arms in turn,
// each from empty data stores with the mock answering late and no faults,
// measures each run, judges each cache against the bar, and writes the report.
// Exits 0 once the report is written (whatever the caches' outcomes), 1 when a
// run could not be measured (the runs measured so far stay in `runs.json`),
// 2 when it refuses to run.
import { MockSatusehatClient, type LogEntry, type MockReport } from '@integration-hub/mock-satusehat/client';
import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { planBatch, runBatch } from '@integration-hub/simulator';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { judgeCaches } from './cacherun/judge.js';
import { cacheRequestsOf, measureRun, type RunMeasurement } from './cacherun/measure.js';
import { readmeWithCacheRun, renderCacheRunReport, updateCacheIndex, type CacheRunReport } from './cacherun/report.js';
import { loadCacheRunSettings, type CacheRunSettings, type ScheduledRun } from './cacherun/settings.js';
import { batchOptions } from './batch-options.js';
import { WRITES } from './fault-rules.js';
import { harnessEnv } from './harness-env.js';
import { readCaseViews } from './hub-cases.js';
import { judge } from './judge.js';
import { manifestFor } from './manifest.js';
import { checkTopology, isWorker, officialGuard } from './preflight.js';
import { newRunDirectory, runDirectoryBase } from './run-directory.js';
import { SettingsError } from './settings.js';
import { captureEnvironment, COMMITMENTS_FILE, composeUp, inspectContainers, readGitFacts, resetDataStores, type Environment } from './system.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));

const env = harnessEnv;
const hubUrl = new URL(env.BIGRUN_HUB_URL);
const mockUrl = new URL(env.BIGRUN_MOCK_URL);
const workerUrls = env.BIGRUN_WORKER_URLS.split(',').map((url) => new URL(url.trim()));

/** Ends the process without running: exit 2, each reason on its own line. */
function refuse(reasons: readonly string[]): never {
  for (const reason of reasons) log(`refused: ${reason}`);
  process.exit(2);
}

let settings: CacheRunSettings;
try {
  settings = loadCacheRunSettings(JSON.parse(await readFile(`${repoRoot}/${COMMITMENTS_FILE}`, 'utf8')), process.argv.slice(2));
} catch (err) {
  if (err instanceof SettingsError) refuse([err.message]);
  throw err;
}
const { bigRun, cacheRun, schedule, kind, overrides } = settings;
log('cache run settings', { kind, runs: schedule.length, visitsPerRun: bigRun.events.visits, overrides });

const git = await readGitFacts(repoRoot);
if (kind === 'official') {
  const problems = officialGuard(git);
  if (problems.length > 0) refuse(problems);
}

const world = await loadWorld(DEFAULT_WORLD_PATH);
const startedAt = new Date();
const base = runDirectoryBase(startedAt, git.headSha);
const dir = kind === 'official' ? await newRunDirectory(repoRoot, 'results/cache', base) : await newRunDirectory(repoRoot, 'results/cache-unofficial', `${base}-unofficial`);
log('run directory', { dir: dir.path });

const runs: RunMeasurement[] = [];
let environment: Environment | undefined;
for (const [i, scheduled] of schedule.entries()) {
  log(`run ${i + 1} of ${schedule.length}: ${scheduled.arm}`, { ihsCaches: scheduled.ihsCaches });
  const measured = await oneRun(i + 1, scheduled);
  environment ??= measured.environment;
  runs.push(measured.run);
  log(`run ${i + 1} measured`, { arm: scheduled.arm, readsPerCase: measured.run.upstreamReadsPerCompletedCase, e2eP95: measured.run.endToEndP95Seconds });
  // Each run's measurements are written as they come, so an interrupted Cache run keeps them.
  await writeJson(`${dir.path}/runs.json`, runs);
}
if (environment === undefined) refuse(['the schedule has no runs']);

const decisions = judgeCaches(runs, cacheRun.barToStay);
const report: CacheRunReport = {
  dir: dir.name,
  kind,
  startedAt: startedAt.toISOString(),
  endedAt: new Date().toISOString(),
  provenance: { gitSha: git.headSha, uncommitted: git.uncommitted, commitmentsSha256: git.commitments.sha256, commitmentsCommit: git.commitments.lastCommit },
  overrides,
  visitsPerRun: bigRun.events.visits,
  cacheRun,
  runs,
  decisions,
  environment,
};
await writeJson(`${dir.path}/report.json`, report);
await writeFile(`${dir.path}/report.md`, renderCacheRunReport(report));
if (kind === 'official') {
  const indexPath = `${repoRoot}/results/cache/INDEX.md`;
  await writeFile(indexPath, updateCacheIndex(existsSync(indexPath) ? await readFile(indexPath, 'utf8') : null, report));
  const readmePath = `${repoRoot}/README.md`;
  await writeFile(readmePath, readmeWithCacheRun(await readFile(readmePath, 'utf8'), report));
}
for (const d of decisions) log(`${d.cache}: ${d.measuredBarsPass ? 'clears bars 1 and 2' : 'misses the bar'}`, { readsReduction: d.upstreamReads.reduction, e2eP95Improvement: d.endToEndP95.improvement });
log('cache run done', { report: `${dir.path}/report.md` });

/**
 * One run: empty Postgres and Redis, the stack recreated with the arm's
 * caches, the mock's latency set, the committed batch sent and drained, and
 * its measurements read. Refuses (exit 2) if the stack is not the committed one.
 */
async function oneRun(n: number, scheduled: ScheduledRun): Promise<{ run: RunMeasurement; environment: Environment }> {
  await resetDataStores(repoRoot);
  await composeUp(repoRoot, { TRACE_SAMPLE_RATIO: String(bigRun.tracing.sampleRatio), RECONCILIATION_INTERVAL_MS: '0', IHS_CACHES: scheduled.ihsCaches });
  const containers = await inspectContainers(repoRoot);
  const problems = checkTopology(bigRun, containers, { hubUrl, mockUrl });
  for (const c of containers.filter(isWorker)) {
    if (c.env.IHS_CACHES !== scheduled.ihsCaches) problems.push(`${c.service} IHS_CACHES is ${c.env.IHS_CACHES ?? 'unset'}, the arm needs ${scheduled.ihsCaches}`);
  }
  if (problems.length > 0) refuse(problems);
  const mock = new MockSatusehatClient(mockUrl);
  // Answers only if it is the mock: the real platform has no `/__mock/report`.
  await mock.report();
  const environment = await captureEnvironment(repoRoot, containers);
  await mock.setFaults(latencyRules(cacheRun.mockLatencyMs, bigRun.seed));

  const runId = `${Date.now().toString(36).toUpperCase()}C${n}`;
  const plan = planBatch(world, batchOptions(bigRun, runId));
  const manifest = manifestFor(plan, { kind: 'unofficial', bigRun, overrides: [] }, new Date());
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
  const caseReads = await readCaseViews({ baseUrl: hubUrl, adminApiKey: env.BIGRUN_ADMIN_API_KEY }, batch.cases.map((c) => c.caseId));
  let mockLog: LogEntry[] = [];
  let mockReport: MockReport = { faultSeed: null, duplicates: [], outOfOrder: [], overlap: [] };
  try {
    mockLog = await mock.logNdjson();
    mockReport = await mock.report();
  } catch (err) {
    // Not carried on from: without the mock's log there are no upstream reads to count.
    throw new Error(`run ${n}: reading the mock failed, so its upstream reads can't be counted`, { cause: err });
  }
  const expositions = await Promise.all(
    workerUrls.map(async (url) => {
      const res = await fetch(new URL('metrics', url));
      if (!res.ok) throw new Error(`run ${n}: ${url.href}metrics answered ${res.status}`);
      return res.text();
    }),
  );
  const judgement = judge({ bigRun, visits: manifest.visits, batch, cases: caseReads.views, mockLog, mockReport });
  const run = measureRun({ run: n, scheduled, runId, judgement, mockLog, cases: caseReads.views, cacheRequests: cacheRequestsOf(expositions) });
  return { run, environment };
}

/** The Cache run's only fault rules: every read and every write answered late, by the committed constants. The token endpoint is neither. */
function latencyRules(latency: CacheRunSettings['cacheRun']['mockLatencyMs'], seed: number) {
  return {
    seed,
    rules: [
      { id: 'cacherun:reads', match: { method: 'GET' as const }, kind: 'latency' as const, params: { ms: latency.reads }, rate: 1 },
      ...WRITES.map((w) => ({
        id: `cacherun:writes:${w.method}-${w.resourceType}`,
        match: { method: w.method, resourceType: w.resourceType },
        kind: 'latency' as const,
        params: { ms: latency.writes },
        rate: 1,
      })),
    ],
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
