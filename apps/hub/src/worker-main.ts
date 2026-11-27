import { systemClock } from './clock.js';
import { createWorker } from './composition-root.js';
import { loadConfig } from './config.js';

// Worker process entry point (ADR 0001). It never migrates; run the `migrate` command first.
const worker = await createWorker(loadConfig(process.env), { clock: systemClock, logs: process.stdout });
worker.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // The 70s drain and `worker_shutdown` release land with #43.
    void worker.close().then(() => process.exit(0));
  });
}
