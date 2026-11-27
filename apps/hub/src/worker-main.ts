import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { systemClock } from './clock.js';
import { createWorker, type HubWorker } from './composition-root.js';
import { loadConfig } from './config.js';
import { createLog } from './observability/log.js';
import { startTracing } from './observability/tracing.js';

// Worker process entry point (ADR 0001), started with `--import ./dist/instrumentation.js` (#42).
// It never migrates; run the `migrate` command first. It exits 1 if Postgres stays unreachable
// for 30s or its schema is at another migration than this build's (#43).
const log = createLog('worker', process.stdout);
const config = loadConfig(process.env);
const tracing = startTracing({ service: 'worker', sampleRatio: config.tracing.sampleRatio, exporter: new OTLPTraceExporter({ url: config.tracing.exportUrl.href }) });

/** Flushes the spans not yet exported. Without Jaeger they are lost, as they are while it runs without it: logged, and the exit goes on. */
const flushTraces = () =>
  tracing.shutdown().catch((err: unknown) => log('warn', 'flushing traces failed; the spans not yet exported are lost', { error: err }));

let worker: HubWorker;
try {
  worker = await createWorker(config, { clock: systemClock, logs: process.stdout });
  await worker.listen();
} catch (err) {
  log('error', 'worker failed to start', { error: err });
  await flushTraces();
  process.exit(1);
}

// SIGTERM or SIGINT drains the worker (#43); a second one skips the rest of the drain to its deadline.
let exiting: Promise<void> | undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('info', 'shutdown signal received', { signal });
    const closed = worker.close();
    exiting ??= closed
      .then(flushTraces)
      .then(
        () => process.exit(0),
        (err: unknown) => {
          log('error', 'worker shutdown failed', { error: err });
          process.exit(1);
        },
      );
  });
}
await worker.start();
