import { migrateDatabase } from '../composition-root.js';
import { loadConfig } from '../config.js';
import { log } from '../observability/log.js';

// Entry point of the one-shot `migrate` command.
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
