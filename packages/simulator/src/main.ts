import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { loadConfig } from './config.js';
import { planBatch } from './plan.js';
import { runBatch } from './run.js';

// Source simulator entry point: plans one seeded batch from the world dataset, sends it to the hub
// and waits for every case to complete. Exits 1 if any check failed.
const config = loadConfig(process.env, new Date());
// One JSON line per event, each carrying the run id, which also prefixes every visit id of the batch.
const log = (level: 'info' | 'error', msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, runId: config.batch.runId, ...fields }));

const plan = planBatch(await loadWorld(DEFAULT_WORLD_PATH), config.batch);
const visitsWhere = (predicate: (visit: (typeof plan.visits)[number]) => boolean) => plan.visits.filter(predicate).length;
log('info', 'batch planned', {
  hubUrl: config.hub.baseUrl.href,
  seed: config.batch.seed,
  visits: plan.visits.length,
  events: plan.sends.length,
  duplicates: plan.sends.filter((s) => s.duplicate).length,
  substitution: visitsWhere((visit) => visit.scenario === 'substitution'),
  outOfOrder: visitsWhere((visit) => visit.outOfOrder),
  fallbackLookup: visitsWhere((visit) => visit.lookupMethod !== 'nik'),
});

const result = await runBatch(plan, config.hub, {
  pollIntervalMs: config.pollIntervalMs,
  noProgressTimeoutMs: config.noProgressTimeoutMs,
  deadlineMs: config.deadlineMs,
  report: (line) => log('info', line),
});
for (const problem of result.problems) log('error', problem);
log(result.problems.length === 0 ? 'info' : 'error', result.problems.length === 0 ? 'batch completed: every check held' : `batch failed: ${result.problems.length} problems`);
process.exitCode = result.problems.length === 0 ? 0 : 1;
