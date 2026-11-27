import { DEFAULT_WORLD_PATH, loadWorld } from '@integration-hub/mock-satusehat/world';
import { loadConfig } from './config.js';
import { planBatch } from './plan.js';
import { runBatch } from './run.js';

// Source simulator entry point: plans one seeded batch from the world dataset, sends it to the hub
// and waits for every case to complete. Exits 1 if any check failed.
const config = loadConfig(process.env, new Date());
const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: 'info', msg, ...fields }));

const plan = planBatch(await loadWorld(DEFAULT_WORLD_PATH), config.batch);
const count = (predicate: (v: (typeof plan.visits)[number]) => boolean) => plan.visits.filter(predicate).length;
log('batch planned', {
  hubUrl: config.hub.baseUrl.href,
  seed: config.batch.seed,
  runId: config.batch.runId,
  visits: plan.visits.length,
  events: plan.sends.length,
  duplicates: plan.sends.filter((s) => s.duplicate).length,
  substitution: count((v) => v.scenario === 'substitution'),
  outOfOrder: count((v) => v.outOfOrder),
  fallbackLookup: count((v) => v.lookup !== 'nik'),
});

const result = await runBatch(plan, config.hub, {
  pollIntervalMs: config.pollIntervalMs,
  completionTimeoutMs: config.completionTimeoutMs,
  report: (line) => log(line),
});
for (const problem of result.problems) console.log(JSON.stringify({ level: 'error', msg: problem }));
log(result.problems.length === 0 ? 'batch completed: every check held' : `batch failed: ${result.problems.length} problems`);
process.exitCode = result.problems.length === 0 ? 0 : 1;
