import { createHub } from './composition-root.js';
import { loadConfig } from './config.js';
import { log } from './observability/log.js';

// Hub service entry point. It never migrates; run the `migrate` command first.
const hub = await createHub(loadConfig(process.env));
const baseUrl = await hub.listen();
log('info', 'hub service listening', { url: baseUrl.href });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // Graceful drain (503 SERVICE_DRAINING, 10s deadline) lands with #43.
    void hub.close().then(() => process.exit(0));
  });
}
