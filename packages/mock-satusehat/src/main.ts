import { systemClock } from './clock.js';
import { createMockSatusehat } from './composition-root.js';
import { loadConfig } from './config.js';

// Mock SATUSEHAT entry point. Never deploy it publicly: `/__mock/*` has no auth.
const mock = await createMockSatusehat(loadConfig(process.env), { clock: systemClock });
const baseUrl = await mock.listen();
console.log(JSON.stringify({ level: 'info', msg: 'mock SATUSEHAT listening', url: baseUrl.href }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void mock.close().then(() => process.exit(0)));
}
