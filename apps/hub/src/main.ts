import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { systemClock } from './clock.js';
import { createHub } from './composition-root.js';
import { loadConfig } from './config.js';
import { startTracing } from './observability/tracing.js';

// Hub service entry point, started with `--import ./dist/instrumentation.js` (#42).
// It never migrates; run the `migrate` command first.
const config = loadConfig(process.env);
const tracing = startTracing({ service: 'hub', sampleRatio: config.tracing.sampleRatio, exporter: new OTLPTraceExporter({ url: config.tracing.exportUrl.href }) });
const hub = await createHub(config, { clock: systemClock, logs: process.stdout });
await hub.listen();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // Graceful drain (503 SERVICE_DRAINING, 10s deadline) lands with #43.
    void hub
      .close()
      .then(() => tracing.shutdown())
      .then(() => process.exit(0));
  });
}
