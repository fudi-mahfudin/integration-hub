import { migrateDatabase } from '../composition-root.js';
import { loadConfig } from '../config.js';
import { createLog } from '../observability/log.js';

// Entry point of the one-shot `migrate` command, a hub service command: its lines say `service: hub`.
const log = createLog('hub', process.stdout);
try {
  const results = await migrateDatabase(loadConfig(process.env));
  for (const result of results) {
    log('info', 'migration applied', { migration: result.migrationName, status: result.status });
  }
  log('info', results.length === 0 ? 'migrate: schema already up to date' : 'migrate: done');
} catch (err) {
  log('error', 'migrate: failed', { error: err });
  process.exitCode = 1;
}
