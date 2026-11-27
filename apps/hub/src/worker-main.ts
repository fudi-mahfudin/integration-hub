import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { systemClock } from './clock.js';
import { createWorker } from './composition-root.js';
import { loadConfig } from './config.js';
import { startTracing } from './observability/tracing.js';

// Worker process entry point (ADR 0001), started with `--import ./dist/instrumentation.js` (#42).
// It never migrates; run the `migrate` command first.
const config = loadConfig(process.env);
const tracing = startTracing({ service: 'worker', sampleRatio: config.tracing.sampleRatio, exporter: new OTLPTraceExporter({ url: config.tracing.exportUrl.href }) });
const worker = await createWorker(config, { clock: systemClock, logs: process.stdout });
await worker.listen();
worker.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // The 70s drain and `worker_shutdown` release land with #43.
    void worker
      .close()
      .then(() => tracing.shutdown())
      .then(() => process.exit(0));
  });
}
