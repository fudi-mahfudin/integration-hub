import { createWorker } from './composition-root.js';
import { loadConfig } from './config.js';

// Worker entry point (ADR 0001): same codebase as the hub service. It never migrates.
const worker = await createWorker(loadConfig(process.env));
worker.start();
console.log('worker claiming steps');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // The 70s drain and `worker_shutdown` release land with #43.
    void worker.close().then(() => process.exit(0));
  });
}
