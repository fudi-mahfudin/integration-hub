import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { systemClock } from './clock.js';
import { createHub, type Hub } from './composition-root.js';
import { loadConfig } from './config.js';
import { createLog } from './observability/log.js';
import { startTracing } from './observability/tracing.js';

// Hub service entry point, started with `--import ./dist/instrumentation.js` (#42).
// It never migrates; run the `migrate` command first. It exits 1 if Postgres stays unreachable
// for 30s or its schema is at another migration than this build's (#43).
const log = createLog('hub', process.stdout);
const config = loadConfig(process.env);
const tracing = startTracing({ service: 'hub', sampleRatio: config.tracing.sampleRatio, exporter: new OTLPTraceExporter({ url: config.tracing.exportUrl.href }) });

/** Flushes the spans not yet exported. Without Jaeger they are lost, as they are while it runs without it: logged, and the exit goes on. */
const flushTraces = () =>
  tracing.shutdown().catch((err: unknown) => log('warn', 'flushing traces failed; the spans not yet exported are lost', { error: err }));

let hub: Hub;
try {
  hub = await createHub(config, { clock: systemClock, logs: process.stdout });
  await hub.listen();
} catch (err) {
  log('error', 'hub service failed to start', { error: err });
  await flushTraces();
  process.exit(1);
}

// SIGTERM or SIGINT drains the hub service (#43): 503 SERVICE_DRAINING, 10s for requests in flight.
let exiting: Promise<void> | undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('info', 'shutdown signal received', { signal });
    exiting ??= hub
      .close()
      .then(flushTraces)
      .then(
        () => process.exit(0),
        (err: unknown) => {
          log('error', 'hub service shutdown failed', { error: err });
          process.exit(1);
        },
      );
  });
}
